const {
    injectOptions,
    global: globalOpts,
    output: outputOpts,
    extract: extractOpts
} = require('./_options')
const { parseRoom } = require('../lib/parser')
const { getRoomInfo, getRoomUser, getPlayUrls } = require('../lib/bili-api')
const { spawn } = require('child_process')
const { createWriteStream, getFileSize, getOutputPath } = require('../lib/fs')
const { unlink, renameSync } = require('fs')
const dateformat = require('dateformat')
const { resolve: resolveUrl } = require('url')
const { sendMessage, editMessageText } = require('../lib/telegram-api')
const { parseArgsStringToArgv } = require('string-argv')
const { PassThrough } = require('stream')
const { resolve: pathResolve } = require('path')
const { HighAvailabilityDanmakuStream } = require('../lib/danmaku')
const DanmakuConverter = require('../lib/danmaku-converter')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// used to catch empty stream caused by liveStatus update lag
// output files < this threshold is considered to be empty
const BLANK_STREAM_FILE_SIZE_THRESHOLD = 1024

// interval between live status checks, in milliseconds
const LIVE_STATUS_CHECK_INTERVAL = 60 * 1000

const NODE_EXEC = process.execPath
const HIKARU_EXEC = pathResolve(__dirname, '../bin/hikaru')

if (process.env['PREVENT_CTRL_C']) {
    // 调试用: prevent ctrl-c
    process.on('SIGINT', async () => {});
}

function spawnFfmpeg(format) {
    const formatMap = {
        mkv: 'matroska'
    }
    // 使用fragment形式存储，并将moov移动到文件开头
    const args = ['-i', 'pipe:0', '-c', 'copy', '-movflags', 'faststart+empty_moov', '-f', formatMap[format] || format, 'pipe:1']
    const ffmpeg = spawn('ffmpeg', args);
    ffmpeg.on('exit', () => {
        console.log('ffmpeg exit')
    });
    ffmpeg.stderr.on('data', function (data) {
        // console.log('ffmpeg stderr: ' + data);
    });
    return ffmpeg;
}

function moveMoovToBegin (outputPath) {
    console.log('😈 正在修正视频时间头信息')
    const tmpFile = outputPath.replace(/^(.*)(\.[^\.]+)$/, '$1.tmp$2');
    // 使用fragment形式存储，并将moov移动到文件开头
    const args = ['-i',  outputPath, '-c', 'copy', '-movflags', 'faststart', tmpFile]
    const ffmpeg = spawn('ffmpeg', args);
    ffmpeg.on('exit', () => {
        console.log('ffmpeg(moov) exit')
    });
    return new Promise(resolve => ffmpeg.once('close', (code) => {
        unlink(outputPath, (err) => {
            console.log(err || `😈 已删除文件 ${outputPath}`)
            if (!err) {
                console.log(`正在重命名临时文件 ${tmpFile}`);
                renameSync(tmpFile, outputPath);
                console.log(`重命名文件成功 ${outputPath}`);
            }
        })
        resolve(code === 0)
    }))
}

async function getFlvStream(url, referer) {
    const args = [
        '-L',    // follow redirect
        '-S',    // print error
        '-y',    // speed time, used to kill stagnated stream
        '10',    //     10s
        '-Y',    // speed limit, used to detect stagnated stream
        '10000', //     10 kB/s, estimated from basic audio stream bitrate (~128kbps -> 16kB/s)
        '-H',    // bilibili CDN wants UA, so they have a fake one :)
        'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.132 Safari/537.36',
        '-H',    // fake referer, in case of CDN wanting it
        `Referer: ${referer}`,
        url,
    ]

    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stderr.pipe(process.stderr)

    return child.stdout
}

async function sendNotification(tgOpts, messageArgs) {
    const {
        telegramEndpoint,
        telegram,
        silent
    } = tgOpts || {}

    const {
        token,
        chatId
    } = telegram || {}

    if (token && chatId) {
        const botApi = resolveUrl(telegramEndpoint, `/bot${token}`)

        try {
            const {
                messageId
            } = await sendMessage(botApi, {
                chat_id: chatId,
                disable_notification: silent,
                disable_web_page_preview: true,
                ...messageArgs
            })
            console.error(`✉️  Telegram 消息已投递`)

            return {
                editMessageText: args => editMessageText(botApi, {
                    chat_id: chatId,
                    message_id: messageId,
                    disable_notification: true,
                    disable_web_page_preview: true,
                    ...args
                }).then(
                    success => console.error(`✉️  Telegram 消息已更新`),
                    error => console.error(`✉️  Telegram 消息更新失败：${error.message}`)
                )
            }
        } catch(error) {
            console.error(`✉️  Telegram 消息投递失败：${error.message}`)
            return {
                editMessageText: args => Promise.resolve(null)
            }
        }
    } else {
        return {
            editMessageText: args => Promise.resolve(null)
        }
    }
}

function formatTimeDuration(secs) {
    const date = new Date(secs)
    return dateformat(date, 'UTC:HH:MM:ss')
}

/*
 * params:
 *   outputPath: path to write captured flv
 *   canonicalRoomId: canonical room id
 *   extractOpts: if provided, {
 *     type: String
 *     args: String, additional arguments to extract command
 *     realtime: Boolean, whether to perform analysis in real time
 *   }
 *
 * resolves when flv stream ends.
 *
 * caller should check whether if this is caused by network error (i.e. stagnation),
 * or the host stops streaming (check LIVE_STATUS)
 *
 * returns:
 *   {
 *     promiseFlvStreamFinish:  promise resolves to a boolean when flv stream ends
 *                              it resolves immediately when this function returns
 *                               - true if curl finishes without error
 *                               - false if curl exits with non-zero code
 *     promiseExtractionFinish: promise resolves to a boolean when extraction finishes,
 *                               - true indicates extraction is successful
 *                               - false indicates extraction fails
 *                                 (caller should preserve original stream in this case)
 *   }
 */
async function captureStream(outputPath, canonicalRoomId, extractOpts = false) {
    const {
        quality,
        urls,
    } = await getPlayUrls(canonicalRoomId)

    if (urls.length === 0) {
        throw new Error('Stream list is empty')
    }

    console.error(`☑️  视频流捕获 Qual.${quality}：`)
    urls.forEach(entry => console.error(`    ${entry.url}`))

    console.error(`🌟  点亮爱豆……`)
    console.error(`    开始发光：${dateformat(new Date(), 'yyyy-mm-dd HH:MM:ss')}`)
    console.error(`    ${outputPath}`)
    console.error('')

    const outputStream = outputPath === '-' ? process.stdout : createWriteStream(outputPath)

    const dmkConverter = new DanmakuConverter({output: outputPath.replace(/\.[^\.]+$/, ".ass")})
    let dmk = new HighAvailabilityDanmakuStream(canonicalRoomId)
    dmk.connect();
    dmk.on('danmaku', (danmakuStr, meta) => {
        const danmaku = JSON.parse(danmakuStr)
        if (danmaku.cmd === 'DANMU_MSG') {
            dmkConverter.push(danmaku)
        }
    })

    dmk.on('activeClose', () => {
        dmkConverter.close();
    })

    const refererUrl = `https://live.bilibili.com/${canonicalRoomId}`
    const flvStream = await getFlvStream(urls[0].url, refererUrl)
    const ffmpeg = spawnFfmpeg(outputPath.match(/\.([^\.]+)$/)[1]);

    const passToOutput = new PassThrough()
    passToOutput.pipe(outputStream)
    flvStream.pipe(ffmpeg.stdin)
    ffmpeg.stdout.pipe(passToOutput)

    let promiseFlvStreamFinish = new Promise(resolve => outputStream.once('close', _ => resolve(true)))
    let promiseExtractionFinish = null

    // setup realtime extraction if necessary
    if (extractOpts && extractOpts.realtime) {
        const { type, args } = extractOpts
        const passToExtract = new PassThrough()
        const extractProcess = spawn(NODE_EXEC, [
            HIKARU_EXEC,
            'extract',
            '-',
            '--ref-path',
            outputPath,
            '--type',
            type,
            ...parseArgsStringToArgv(args || '')
        ], {
            stdio: [ 'pipe', 'ignore', 'pipe' ]
        })
        passToExtract.pipe(extractProcess.stdin)
        flvStream.pipe(passToExtract)
        extractProcess.stderr.pipe(process.stderr)
        promiseExtractionFinish = new Promise(resolve => extractProcess.once('close', (code) => resolve(code === 0)))
    }

    await promiseFlvStreamFinish

    dmk.close();

    // nuke blank stream
    const fileSize = await getFileSize(outputPath)
    if (fileSize < BLANK_STREAM_FILE_SIZE_THRESHOLD) {
        unlink(outputPath, err => err || console.error(`😈  删除空的视频流：${outputPath}`))
        const assFilePath = outputPath.replace(/\.[^\.]+$/, ".ass");
        unlink(assFilePath, err => err || console.error(`😈  删除空的视频流弹幕：${assFilePath}`))
    }

    if (fileSize && extractOpts && !extractOpts.realtime) {
        const { type, args } = extractOpts
        const extractProcess = spawn(NODE_EXEC, [
            HIKARU_EXEC,
            'extract',
            outputPath,
            '--type',
            type,
            ...parseArgsStringToArgv(args || '')
        ], {
            stdio: [ 'ignore', 'ignore', 'pipe' ]
        })
        extractProcess.stderr.pipe(process.stderr)
        promiseExtractionFinish = new Promise(resolve => extractProcess.once('close', (code) => resolve(code === 0)))
    }

    return {
        promiseFlvStreamFinish,
        promiseExtractionFinish: promiseExtractionFinish || Promise.resolve(true)
    }
}

async function convertContainerFormat(sourcePath, targetPath, targetFormat = 'flv') {
    if (targetFormat === 'flv') {
        return Promise.resolve(0)
    }

    if (targetFormat === 'mkv') {
        targetFormat = 'matroska'
    }

    const args = [
        '-hide_banner',
        '-i',
        sourcePath,
        '-c',
        'copy',
        '-format',
        targetFormat,
        targetPath,
    ]

    return new Promise(resolve => {
        const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })

        child.once('exit', (code) => {
            console.error('')
            console.error(`ffmpeg exits with: ${code}`)
            console.error('')

            if (code === 0) {
                unlink(sourcePath, err => err || console.error(`😈  删除原始flv流：${sourcePath}`))
            } else {
                console.error(`ffmpeg fails, keep original file`)
            }

            resolve(code)
        })

        child.stderr.pipe(process.stderr)
    })
}

module.exports = {
    yargs: yargs => injectOptions(yargs, globalOpts, outputOpts, extractOpts)
        .usage('$0 run <room_id>')
        .positional('room_id', {
            describe: 'room id or live url',
            type: 'string'
        })
    ,

    /*
     * throws if bili-api become ridiculous (changed)
     * return 0 if success
     * return non-zero if error
     */
    handler: async argv => {
        const {
            outputDir,
            output,
            room_id,
            telegramEndpoint,
            telegram = null,
            silent = false,
            format = 'flv',
            extract = false,
            extractArgs = '',
            realtimeAnalyze = false,
        } = argv

        let { noCapture = false } = argv;

        const telegramOpts = { telegramEndpoint, telegram, silent }

        if (extract && (output === '-' || output === '')) {
            console.error(`--extract can not work with stdout output`)
            process.exit(1)
        }

        try {
            // get idol information
            const inputRoomId = parseRoom(room_id)
            const {
                roomId: canonicalRoomId,
                liveStatus,
                liveStartsAt,
                title,
            } = await getRoomInfo(inputRoomId)
            const {
                name
            } = await getRoomUser(canonicalRoomId)

            if (liveStatus !== 1) {
                console.error(`⭐️  ${name} 不在直播 ${liveStatus}`)
                return 0
            }

            console.error(`⭐️  ${name} 直播中 ${liveStartsAt}`)

            // send message asynchronously, do not block
            const notificationPromise = sendNotification(telegramOpts, {
                parse_mode: 'HTML',
                text: `🌟hikaru: <a href="https://live.bilibili.com/${canonicalRoomId}">${name} (${canonicalRoomId})</a> 开始直播「${title}」啦，快去让 TA 发光吧！`,
            })

            // keep going until liveStatus changes to NOT_LIVE (1)
            // this is to deal with minor streaming disruptions (i.e. CDN network congestion)
            // NOTE: warn that template should contain a counter (i.e. time), or previous one will be overwritten
            const captureStartsAt = Date.now()

            while (true) {
                if (noCapture) {
                    // sleep until live state changes
                    await sleep(LIVE_STATUS_CHECK_INTERVAL)
                } else {
                    // capture stream
                    const flvTime = dateformat(new Date(), 'yyyy-mm-dd_HHMMss')
                    const outputPath = getOutputPath(output, outputDir, { idol: name, ext: format, time: flvTime, title })
                    const extractOpts = extract ? {
                        type: extract,
                        realtime: realtimeAnalyze,
                        args: extractArgs || ''
                    } : false

                    const {
                        promiseExtractionFinish
                    } = await captureStream(outputPath, canonicalRoomId, extractOpts)

                    // asynchronously convert container format
                    promiseExtractionFinish.then(success => {
                        if (success) {
                            console.error(`run: extraction success.`)
                            return moveMoovToBegin(outputPath)
                        } else {
                            console.error(`run: extraction fails, will not convert container format`)
                        }
                    })
                }

                const {
                    liveStatus: postCaptureLiveStatus,
                    title: postCaptureTitle,
                } = await getRoomInfo(inputRoomId)

                if (postCaptureLiveStatus !== 1) {
                    console.error(`⭐️  ${name} 直播结束 ${liveStatus}`)

                    // compute statistics
                    const capturedDuration = Date.now() - captureStartsAt
                    // TODO: add stat about actual capture time, disruption count, etc.

                    // update telegram notification asynchronously, do not block
                    const outcomeStr = noCapture ? '时长' : '已捕获'
                    notificationPromise.then(notification => {
                        notification.editMessageText({
                            parse_mode: 'HTML',
                            text: `🌟hikaru: <a href="https://live.bilibili.com/${canonicalRoomId}">${name} (${canonicalRoomId})</a> 直播「${postCaptureTitle}」结束，${outcomeStr} ${formatTimeDuration(capturedDuration)}。`,
                            disable_notification: true,
                            disable_web_page_preview: true,
                        })
                    })
                    return 0
                }
            }
        } catch(e) {
            console.error(e.stack)
            return 2
        }
    },

    // expose sendNotification method for testing
    sendNotification
}
