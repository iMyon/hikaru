const fs = require('fs');

const config = {
    PlayResX: 1920, // 分辨率 宽
    PlayResY: 1080, // 分辨率 高
    font: '微软雅黑', // 字体
    bold: true, // 是否加粗
    fontSize: 40, // 字体大小
    lineLimit: 50, // 弹幕最大行数
    duration: 12000, // 滚动弹幕驻留时间（毫秒秒）
    fixedSpeed: 4, // 顶端/底部弹幕驻留时间（秒），越小越快
    alpha: 180, // 弹幕透明度,256为全透明，0为不透明
    accurateDanmakuWidth: false, // 使用canvas计算弹幕宽度，精准度提升，滚动弹幕排版更合理，但是非常影响处理效率，建议处理少量弹幕转换时开启
}

let assHeader = `\ufeff[Script Info]
ScriptType: v4.00+
Collisions: Normal
PlayResX: ${config.PlayResX}
PlayResY: ${config.PlayResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,微软雅黑,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0.00,0.00,1,1,0,2,20,20,120,0
Style: Danmaku,${config.font},${config.fontSize},&H${config.alpha}FFFFFF,&H${
    config.alpha
}FFFFFF,&H${config.alpha}000000,&H${config.alpha}000000,${~~config
    .bold},0,0,0,100,100,0.00,0.00,1,1,0,2,20,20,20,0

[Events]
Format: Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
class DanmakuConverter {
    constructor({output}) {
        this.assStream = fs.createWriteStream(output);
        this.assStream.write(assHeader);
        this.startTime = new Date().getTime();
    }

    closed = false;

    startTime = 0;

    lineLatestDanmaku = Array(config.lineLimit); // 每行最新弹幕
    getLine (danmakuInfo) {
        for (let i = 0; i < this.lineLatestDanmaku.length; i++) {
            const d = this.lineLatestDanmaku[i];
            if (d === undefined) return i;
            const originDanmakuWidth = getTextWidth(d.content, config.fontSize);
            const danmakuWidth = getTextWidth(danmakuInfo.content, config.fontSize);
            const beforeLeaveTimestamp = danmakuInfo.timestamp + config.duration * config.PlayResX / (config.PlayResX + danmakuWidth);
            const originFullDisplayDuration = config.duration * originDanmakuWidth / (config.PlayResX + originDanmakuWidth)
            // 判断开始进入时不重叠、最终离开时不重叠
            if (danmakuInfo.timestamp > originFullDisplayDuration + d.timestamp &&
                 beforeLeaveTimestamp > d.timestamp + config.duration) {
                return i;
            }
        }
        return -1;
    }
    push (danmaku) {
        if (this.closed) {
            console.log('danmaku after close')
            return;
        }
        const {cmd, info: [[,mode, fontSize, fontColor, timestamp], content, [, username]]} = danmaku;
        const danmakuInfo = {
            mode,
            fontSize,
            fontColor,
            timestamp,
            content,
            username
        }
        if (cmd !== 'DANMU_MSG') return;

        const line = this.getLine(danmakuInfo);
        if (line === -1) return;
        this.lineLatestDanmaku[line] = danmakuInfo;

        const x1 = config.PlayResX + getTextWidth(content, config.fontSize) / 2;
        const x2 = -getTextWidth(content, config.fontSize) / 2;
        const y1 = config.fontSize * (line + 1);
        const y2 = y1;
        const start = formatTime(timestamp - this.startTime);
        const end = formatTime(timestamp - this.startTime + config.duration);
        const color = ((c) => c[4] + c[5] + c[2] + c[3] + c[0] + c[1])(fontColor.toString(16));
        const dialogue = `\nDialogue: 1,${start},${end},Danmaku,${username.replace(',', '')},0000,0000,0000,,\
{\\move(${x1}, ${y1}, ${x2}, ${y2})\\c&H${color}}${content}`;
        this.assStream.write(dialogue);
    }
    close () {
        this.assStream.close();
        this.closed = true;
    }
}

/**
 * 格式化ass时间显示0:00:00.00
 * @param millisecond
 * @returns {string}
 */
function formatTime(millisecond) {
    const cs = ~~(millisecond % 1000 / 10);
    const second = ~~(millisecond / 1000)
    const ss = second % 60;
    const mm = ~~(second / 60) % 60;
    const hh = ~~(second / 60 / 60);
    let padStart2 = (num) => (num + '').padStart(2, '0');
    return hh + ':' + padStart2(mm) + ':' + padStart2(ss) + '.' + padStart2(cs);
}

function getTextWidth (text, fontSize) {
    // TODO 直播弹幕要求性能不高，可以考虑用canvas计算准确宽度
    return text.length * fontSize;
}


module.exports = DanmakuConverter;
