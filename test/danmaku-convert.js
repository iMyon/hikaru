const test = require('tape');
const fs = require('fs')
const DanmakuConverter = require('../lib/danmaku-converter')


test('timing test', function (t) {
    t.equal(typeof Date.now, 'function');
    t.end();
});

test('push', function (t) {
    const output = '1.txt';
    const d = new DanmakuConverter({ output });
    d.push()
    t.equal(fs.existsSync(output), true)
    fs.unlinkSync(output);
    t.end();
});
