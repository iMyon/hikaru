const fs = require('fs')
const os = require('os')
const {dirname, basename, extname, resolve, join} = require('path')
const mktemp = require('mktemp')
const {resolvePath, ensureDir, getOutputPath, createWriteStream} = require('../lib/fs')
const expandTemplate = require('../lib/string-template')
const {spawn} = require('child_process')

const ANALYZERS = require('./_analyzers')
/*
 * ANALYZERS is mapping from extraction type to actual analyze/segment backends
 *
 * Each backend supports the following methods:
 *   analyzeStream(mediaStream, argStr) => { resultStream, errorStream, onFinish (Promise) }
 *   analyzeFile(mediaPath, argStr) => { resultStream, errorStream, onFinish (Promise) }
 *   segmentFile(analyzeResultPath, argStr) => Promise:
 *       resolves to { segments: [startTime, endTime], allOk: boolean }
 *       or, rejects to an error
 *   getDefaultAnalyzeResultPath(mediaPath) => path to analyze result, or null
 */

const fileExists = path => new Promise(resolve => fs.access(path, fs.constants.F_OK, (err) => resolve(!err)))
const toTimeRepr = sec => {
    const pad2 = v => String(v).padStart(2, '0')
    const h = Math.floor(sec / 3600)
    const m = Math.floor(sec / 60) % 60
    const s = Math.floor(sec % 60)
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`
}
const toDurationSpec = sec => {
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m} min ${s} sec`
}

// return Promise -> analyzerResultPath
async function ensureAnalyzerResult({
    stream = null,
    mediaPath,
    analyzerResultSpec,
    type,
    fresh = false,
    analyzerArgs = '',
    persistResult = false
}) {
    const {
        analyzeStream,
        analyzeFile,
        getDefaultAnalyzeResultPath,
    } = ANALYZERS[type]

    // if analyzerResult exists, reuse it
    const analyzerResultPathToProbe = analyzerResultSpec ? analyzerResultSpec : getDefaultAnalyzeResultPath(mediaPath)
    const analyzerResultExists = !fresh && analyzerResultPathToProbe && await fileExists(analyzerResultPathToProbe)
    if (analyzerResultExists) {
        console.error(`Reuse analyze result: ${analyzerResultPathToProbe}`)
        return analyzerResultPathToProbe
    }

    // otherwise, run analysis process
    const analyzerResultPath = persistResult
        ? typeof persistResult === 'string'
          ? persistResult
          : getDefaultAnalyzeResultPath(mediaPath)
        : await mktemp.createFile(join(os.tmpdir(), `hikaru-analyze-${type}-XXXXX`))

    if (persistResult) {
        console.error(`Perform fresh analyze, save to ${analyzerResultPath} :`)
    } else {
        console.error(`Perform fresh analyze: ${analyzerResultPath}`)
    }

    const analyzerResultStream = createWriteStream(analyzerResultPath)
    const {
        resultStream,
        errorStream,
        onFinish,
        _childProcess
    } = stream ? analyzeStream(stream, analyzerArgs) : analyzeFile(mediaPath, analyzerArgs)

    resultStream.pipe(analyzerResultStream)
    errorStream.pipe(process.stderr)

    // trap early termination / exit
    // and cleanup partial result
    const cleanupPartialResult = () => {
        _childProcess && _childProcess.kill('SIGKILL')
        resultStream.destroy()
        fs.unlinkSync(analyzerResultPath)
        process.off('SIGTERM', cleanupPartialResult)
        process.off('SIGINT', cleanupPartialResult)
        process.off('exit', cleanupPartialResult)
        process.exit(1)
    }

    process.on('exit', cleanupPartialResult)
    process.on('SIGINT', cleanupPartialResult)
    process.on('SIGTERM', cleanupPartialResult)

    const analyzerExitCode = await onFinish

    process.off('SIGTERM', cleanupPartialResult)
    process.off('SIGINT', cleanupPartialResult)
    process.off('exit', cleanupPartialResult)

    return analyzerExitCode === 0 ? analyzerResultPath : null
}

// return ffmpeg exit code
async function extractMediaSegmentTo(media, start, end, format, outputPath) {
    const ffmpegFormat = ({
        'mp4': 'mp4',
        'mkv': 'matroska'
    })[format]
    return new Promise(resolve => {
        const args = [
            '-ss',
            String(start),
            '-i',
            media,
            '-to',
            String(end - start),
            '-c',
            'copy',
            '-format',
            ffmpegFormat,
            '-y',
            outputPath,
        ]
        const child = spawn('ffmpeg', args, stdio = ['ignore', 'ignore', 'ignore'])
        child.once('exit', (code) => { resolve(code) })
    })
}

function mediaSpecIsStdin(media) {
    return media === '-' || media === ''
}

module.exports = {
    ANALYSIS_BACKENDS: ANALYZERS,
    yargs: yargs => yargs
        .usage('$0 pose <media> [options]')
        .positional('media', {
            describe: 'media file to extract, use - for stdin',
            type: 'string'
        })
        .option('t', {
            alias: 'type',
            describe: 'type of extraction to perform',
            choices: Object.keys(ANALYZERS),
            default: 'dance'
        })
        .option('a', {
            alias: 'analyzer-result',
            describe: `path to analyzer result
 : skip analysis phase and use the provided result
 : if not provided, probe analyzer's default`
        })
        .option('A', {
            alias: 'analyzer-args',
            describe: `additional args for analyzer
 : ignored when -a / --analyzer-result is valid`,
            type: 'string',
            nargs: 1,
            default: ''
        })
        .option('p', {
            alias: 'persist-result',
            describe: `persist (save) analyzer result
 : optionally, take a path as argument
 : if path is not provided, save to analyzer default
 : ignored when -a / --analyzer-result is valid`
        })
        .option('S', {
            alias: 'segmentation-args',
            describe: `additional args for segmenration tool`,
            type: 'string',
            nargs: 1,
            default: null
        })
        .option('O', {
            alias: 'output-dir',
            describe: `output directory pattern, supports @var template
 : @basedir  -> media's basedir`,
            type: 'string',
            default: '@basedir/extracted/',
        })
        .option('o', {
            alias: 'output',
            describe: `output file pattern, supports @var template
 : @base    -> media's base name (without extension)
 : @seq     -> segment sequence number
 : @ext     -> output format extension name`,
            default: '@base_@seq.@ext'
        })
        .option('f', {
            alias: 'format',
            describe: 'output container format',
            choices: ['mp4', 'mkv'],
            default: 'mp4'
        })
        .option('F', {
            alias: 'fresh',
            describe: 'perform fresh analysis, implied when media is stdin',
            type: 'boolean',
            default: false
        })
        .option('R', {
            alias: 'ref-path',
            describe: 'reference path when media is stdin',
            type: 'string',
        })
    ,
    handler: async argv => {
        const {
            media,
            type,
            fresh,
            analyzerResult,
            analyzerArgs,
            persistResult,
            segmentationArgs,
            outputDir: _outputDir,
            output,
            format,
            refPath,
        } = argv

        // if media is stdin, refPath must be provided
        if (mediaSpecIsStdin(media) && !refPath) {
            console.error(`when using stdin as media, --ref-path must be provided.`)
            process.exit(1)
        }

        const mediaPath = mediaSpecIsStdin(media) ? refPath : media
        const outputDir = resolvePath(expandTemplate(_outputDir, { basedir: dirname(resolve(process.cwd(), mediaPath)) }))

        const analyzeResultPath = await ensureAnalyzerResult({
            stream: mediaSpecIsStdin(media) ? process.stdin : null,
            mediaPath,
            analyzerResultSpec: analyzerResult,
            type,
            fresh: mediaSpecIsStdin(media) ? true : fresh,
            analyzerArgs,
            persistResult,
        })

        if (!analyzeResultPath) {
            console.error(`\nAnalyzer failed, will not extract.`)
            process.exit(1)
        }

        const { segments } = await ANALYZERS[type].segmentFile(analyzeResultPath, segmentationArgs)

        console.error(`Found ${segments.length} segments.`)
        for (let seq=1 ; seq<=segments.length; seq++) {
            const [start, end] = segments[seq-1]

            console.error(`Extracting segment ${seq}:`)
            console.error(`  start:  ${toTimeRepr(start)}`)
            console.error(`  to:     ${toTimeRepr(end)}`)
            console.error(`  dur:    ${toDurationSpec(end-start)}`)

            const outputPath = getOutputPath(output, outputDir, {
                base: basename(mediaPath, extname(mediaPath)),
                seq,
                ext: format
            })
            if (outputPath === '-') {
                console.error(`  <!> does not work with stdout, terminating`)
                process.exit(2)
                break
            }

            ensureDir(outputPath)
            console.error(`  dest:   ${outputPath}`)

            const code = await extractMediaSegmentTo(mediaPath, start, end, format, outputPath)
            if (code === 0) {
                console.log(`  -> ok`)
            } else {
                console.log(`  -> not ok, ffmpeg exits with ${code}`)
            }
        }

        console.error(`Extraction complete.`)
    }
}