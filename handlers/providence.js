const {
    global: globalOpts,
    database: databaseOpts,
    subscribe: subscribeOpts,
    injectOptions
} = require('./_options')

const AmqpSubscriber = require('../lib/amqp-subscribe')
const parseDanmaku = require('../lib/providence-danmaku-parser')
const { MongoDump } = require('../lib/_mongo')
const moment = require('moment-timezone')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const toStatTime = date => {
    return moment(date).tz('Asia/Shanghai').hour(0).minute(0).second(0).millisecond(0).toDate()
}

function getHostSummaryUpdate(parsedDanmaku) {
    const {
        uname,
        action,
        gold = 0,
        silver = 0,
        ...rest
    } = parsedDanmaku

    return (
          action === 'DANMAKU' ? {
            $inc: { danmaku: 1 },
        }
        : action === 'GIFT' ? {
            $inc: {
                gold,
                silver,
                [`giftSum.${rest.giftName}.num`]: rest.giftNum
            },
            $set: { [`giftSum.${rest.giftName}.type`]: rest.coinType },
            $max: { [`giftSum.${rest.giftName}.price`]: rest.price },
        }
        : action === 'GUARD' ? {
            $inc: {
                gold,
                silver,
                [`guardSum.${rest.guardName}.num`]: rest.guardNum
            },
            $set: { [`guardSum.${rest.guardName}.type`]: rest.coinType },
            $max: { [`guardSum.${rest.guardName}.price`]: rest.price },
        }
        : null
    )
}

function getUserSummaryUpdate(parsedDanmaku) {
    const {
        uname,
        action,
        gold = 0,
        silver = 0,
        ...rest
    } = parsedDanmaku

    return (
          action === 'DANMAKU' ? {
            $set: { uname },
            $inc: { danmaku: 1 },
            $push: {
                'danmakus': {
                    $each: [{ text: rest.text }],
                    $slice: -50000,    // limit maximum amount of danmakus kept in each log entry
                },
            },
        }
        : action === 'GIFT' ? {
            $inc: {
                gold,
                silver,
                [`giftSum.${rest.giftName}.num`]: rest.giftNum
            },
            $set: { uname, [`giftSum.${rest.giftName}.type`]: rest.coinType },
            $max: { [`giftSum.${rest.giftName}.price`]: rest.price },
        }
        : action === 'GUARD' ? {
            $inc: {
                gold,
                silver,
                [`guardSum.${rest.guardName}.num`]: rest.guardNum
            },
            $set: { uname, [`guardSum.${rest.guardName}.type`]: rest.coinType },
            $max: { [`guardSum.${rest.guardName}.price`]: rest.price },
        }
        : null
    )
}

function upsertWithRetry(dbConn, coll, id, updateOperator) {
    let retryCount = 0

    const updateFn = _ => dbConn.getConn().then(
        conn => conn.db().collection(coll).updateOne(
            { _id: id },
            updateOperator,
            { upsert: true },
        ).catch(err => {
            if (err.code === 11000) {
                // retry if we found duplicate key error
                if (++retryCount > 10) {
                    console.error(`retry count exceeded: ${err.message}`)
                    return dbConn.errorHandler(err)
                } else {
                    return sleep(100).then(updateFn)
                }
            } else {
                console.error(err)
                return dbConn.errorHandler(err)
            }
        })
    )

    return updateFn()
}

module.exports = {
    yargs: yargs => injectOptions(yargs, globalOpts, subscribeOpts, databaseOpts)

    ,

    handler: async argv => {
        process.on('SIGTERM', _ => process.exit(0))

        const {
            subscribeUrl,
            subscribeName,
            db
        } = argv

        const sub = new AmqpSubscriber(subscribeUrl, subscribeName)
        sub.connect()

        const dbConn = new MongoDump(db)
        await Promise.race([
            dbConn.connect(),
            sleep(5000)
        ]).then(
            ret => ret || console.error('mongo: connection not established yet, continue anyway.')
        )

        sub.on('message', async _msg => {
            const msg = JSON.parse(_msg)

            const parsed = parseDanmaku(msg)
            if (!parsed) return

            const updateHost = getHostSummaryUpdate(parsed)
            const updateUser = getUserSummaryUpdate(parsed)
            const statTime = toStatTime(msg._rxTime)

            updateHost && upsertWithRetry(
                dbConn,
                'providence_host',
                { time: statTime, roomId: msg.roomId },
                updateHost
            )

            updateUser && upsertWithRetry(
                dbConn,
                'providence_user',
                { time: statTime, uid: parsed.uid, roomId: msg.roomId },
                updateUser
            )
        })
    }
}