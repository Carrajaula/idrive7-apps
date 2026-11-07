'use strict';

// node kit/tools/test_s58_overview.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '../..');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/carrajaula_s58/app.json'), 'utf8'));
const { check } = require(path.join(ROOT, 'kit/runtime/readonly-diag'));
const { Recorder } = require(path.join(ROOT, 'kit/runtime/record'));
const realGauges = require(path.join(ROOT, 'kit/runtime/gauges'));
const themes = require(path.join(ROOT, 'kit/runtime/themes'));
const num = (x) => typeof x === 'number' && isFinite(x);
const originalNow = Date.now, originalTimeout = global.setTimeout, originalLoad = Module._load;
let now = 100000, app, frame, timer, reset;
const reads = [], gauges = [], texts = [], modes = { demo: 'off', boostMax: 3 };
let visible = true, fail = false, missingAmbient = false;
const clicks = {};
const raw = { '4205': 38400, '4201': 25600, '4AB0': 51200, '4AAB': 49152,
    '5889': 4096, '58F3': 5500, '58EF': 60000, '554C': 248, '580F': 96, '59D4': 13610, '6000': 112 };
let monitorReply = [0x6C, 0x88].concat(new Array(36).fill(0));
monitorReply[0x11] = 17;
class Link {
    constructor() { this.available = true; }
    async init() { return this; }
    wake() {}
    async physical(ecu, sid, data) {
        check(ecu, sid, data, false); // the real read-only trust-boundary validation
        if (sid === 0x2C) { if (monitorReply instanceof Error) throw monitorReply; reads.push('MHD 2C 88 01'); return fail ? [0x7F, 0x2C, 0x31] : monitorReply; }
        const did = sid === 0x22 ? Buffer.from(data).toString('hex').toUpperCase() : 'OBD ' + data[0];
        reads.push(did);
        if (fail || (missingAmbient && (did === '4201' || did === 'F433' || did === 'OBD 51'))) return [0x7F, sid, 0x31];
        if (raw[did] === undefined) return [0x7F, sid, 0x31];
        const candidate = Object.values(SPEC.config.sources).reduce((a, b) => a.concat(b), []).find((c) => c.did === did);
        const bytes = candidate.bytes === 1 ? [raw[did]] : [raw[did] >> 8, raw[did] & 255];
        return [0x62].concat(data, bytes);
    }
}
class FakeCar { data() { return { demo: false, oil: 94, coolant: 87 }; } }
const stubs = {
    './kit/mgu': { run(a) { app = a; } }, './kit/car': FakeCar,
    './kit/readonly-diag': { ReadOnlyDiag: Link },
    './kit/gauges': { radial(cv, t, x, y, r, g) { gauges.push(g); realGauges.radial(cv, t, x, y, r, g); }, pageBottom() { return 520; } },
};
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return originalLoad.call(this, path.join(ROOT, 'kit/runtime', req.slice(6)), parent, isMain);
    return originalLoad.call(this, req, parent, isMain);
};
Date.now = () => now;
global.setTimeout = (fn) => { timer = fn; return 0; };
const draw = async () => { gauges.length = texts.length = 0; await frame(); return gauges.map((g) => g.value); };

(async () => {
    try {
        require(path.join(ROOT, 'apps/carrajaula_s58/main'));
        await app.start({ spec: SPEC, settings: { get: (k) => modes[k], onChange() {} },
            signals: { watch(iface, instance, fields) { fields.statusEngineTemperature({ temperatureEngineOilDrive: 142, temperatureEngineDrive: 135 }); return Promise.resolve({}); } }, log: { warn() {} }, theme: () => themes.theme('m_red'),
            canvas(w, h) { const cv = new Recorder(w, h), text = cv.text.bind(cv); cv.text = (s, ...a) => { texts.push(s); return text(s, ...a); }; return cv; },
            ui: { isVisible: (name) => name === 'MAIN' && visible, image() {}, onClick(k, f) { clicks[k] = f; if (k === 'BTN_RESET') reset = f; } },
            loop(n, fps, fn) { frame = fn; },
        });
        await new Promise(setImmediate);
        assert.strictEqual(typeof clicks.BTN_DIAG, 'function', 'diagnostics is inside S58 Overview');
        const diagnostics = async () => {
            await clicks.BTN_DIAG();
            const pages = [];
            for (let i = 0; i < 20; i++) { await draw(); pages.push(texts.join('\n')); await clicks.BTN_DIAG_NEXT(); }
            await clicks.BTN_DIAG();
            return pages.join('\n');
        };
        let diag = await diagnostics();
        assert(diag.includes('TX 22 55 4C') && diag.includes('62 55 4C F8'), 'exact knock request and raw reply');
        assert(diag.includes('TX 2C 88 01') && diag.includes('6C 88'), 'exact MHD request and complete raw reply');
        assert(diag.includes('NOT READ') && diag.includes('SOME/IP'), 'untried candidates and non-UDS data identified');
        assert(diag.includes('temperatureEngineOilDrive=142') && diag.includes('temperatureEngineDrive=135'), 'raw SOME/IP temperature fields visible');
        let v = await draw();
        assert.strictEqual(v[0], 2, 'boost uses measured ambient: (300 - 100) / 100');
        assert(Math.abs(v[1] - 75) < 1e-6, 'WGDC decoding stays in percent');
        assert.strictEqual(v[2], 14.7, 'lambda 1 -> gasoline-equivalent AFR 14.7');
        assert.strictEqual(v[3], 5.5, 'LPFP kPa -> bar');
        assert.strictEqual(v[4], 300, 'rail MPa -> bar');
        assert.strictEqual(v[5], 3, 'signed ECU knock mean: -8 * 0.375 -> 3 degrees retard');
        assert(texts.includes('KNK AVG') && !texts.includes('RAIL TARGET') && !texts.includes('HPFP 2'), 'knock mean replaces target pressure');
        assert(!SPEC.config.sources.railTarget && !reads.includes('5837') && !reads.includes('56C1'), 'rail target is neither configured nor polled');
        raw['554C'] = 0; await timer();
        assert.strictEqual((await draw())[5], 0, 'zero retard is a valid reading');
        raw['554C'] = 8; await timer();
        assert.strictEqual((await draw())[5], 3, 'mean retard displayed as a magnitude');
        delete raw['554C']; await timer();
        assert.strictEqual((await draw())[5], null, 'missing knock mean never becomes zero or ignition timing');
        raw['554C'] = 248; now += 31000; await timer(); await draw();
        assert(texts.includes('17 %') && reads.includes('MHD 2C 88 01'), 'active ethanol comes from custom monitor');
        assert(!SPEC.config.sources.ethanolActive, 'no generic ethanol DID candidates');
        assert(!reads.includes('550D'), 'no generic ethanol request');
        assert(texts.includes('24 °C') && texts.includes('94 °C'), 'IAT and existing car oil reader');
        const originalReply = monitorReply.slice();
        const ethanolText = () => texts[texts.indexOf('ETHANOL ACTIVE') + 1];
        for (const percent of [0, 100]) {
            monitorReply = originalReply.slice(); monitorReply[0x11] = percent;
            now += 31000; await timer(); await draw();
            assert.strictEqual(ethanolText(), percent + ' %', 'valid percentage boundary');
        }
        const invalid = [new Error('transport disconnected'), null, [], [0x7F, 0x2C, 0x31], originalReply.slice(0, 37), originalReply.concat(0)];
        for (const [index, value] of [[0, 0x62], [1, 0x89], [17, 101], [17, 255], [17, -1], [17, 1.5], [17, NaN], [18, undefined]]) {
            const r = originalReply.slice(); r[index] = value; invalid.push(r);
        }
        for (const reply of invalid) {
            monitorReply = reply; now += 31000; await timer(); await draw();
            assert.strictEqual(ethanolText(), '-- %', 'invalid/negative monitor reply never becomes ethanol');
        }
        diag = await diagnostics();
        assert(diag.includes('invalid reply bytes'), 'invalid ethanol reply reason visible');
        monitorReply = [0x7F, 0x2C, 0x31]; now += 31000; await timer();
        diag = await diagnostics();
        assert(diag.includes('7F 2C 31') && diag.includes('NRC 31'), 'ECU refusal visible');
        monitorReply = null; now += 31000; await timer();
        diag = await diagnostics(); assert(diag.includes('no reply'), 'timeout visible');
        monitorReply = originalReply; now += 31000; await timer(); await draw();
        visible = false;
        let count = reads.length; await timer();
        assert.strictEqual(reads.length, count, 'hidden screen does not poll');
        visible = true; missingAmbient = true; await timer();
        assert.strictEqual((await draw())[0], null, 'missing ambient never becomes a fabricated boost');
        missingAmbient = false; now += 31000; await timer();
        v = await draw(); assert.strictEqual(v[0], 2);
        now += 10001;
        assert((await draw()).every((x) => x === null), 'stale diagnostic readings expire');
        assert.strictEqual(ethanolText(), '-- %', 'ethanol also expires');
        diag = await diagnostics(); assert(diag.includes('STALE'), 'stale readings marked with age');
        await timer(); await draw();
        modes.demo = 'on'; await draw(); count = reads.length; await timer();
        assert.strictEqual(reads.length, count, 'demo sends no reads');
        assert(texts.includes('DEMO - SIMULATED DATA'), 'demo is labelled');
        assert(num(gauges[5].value) && gauges[5].value <= 1.1, 'demo averages six corrections, not their maximum');
        assert(texts.includes('17 %'), 'illustrative Active ethanol is labelled by demo banner');
        diag = await diagnostics(); assert(diag.includes('DEMO: requests paused') && !diag.includes('62 55 4C F8'), 'demo cannot present live replies');
        modes.demo = 'off';
        assert((await draw()).every((x) => x === null), 'demo/live transition drops old readings');
        fail = true; await timer();
        assert((await draw()).every((x) => x === null), 'failed reads never show zero');
        await reset();
        console.log('S58 checks passed: units, ECU knock mean, MHD ethanol boundaries/rejections, stale/error handling and demo isolation.');
    } finally {
        Date.now = originalNow; global.setTimeout = originalTimeout; Module._load = originalLoad;
    }
})().catch((e) => { console.error(e); process.exitCode = 1; });
