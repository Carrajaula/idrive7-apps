'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const Misfire = require('./misfire');
const { hex, NRC } = require('./kit/diag');

const W = 1600, H = 520, STALE_MS = 10000, RETRY_MS = 30000;
const num = (v) => typeof v === 'number' && isFinite(v);

mgu.run({
    async start(ctx) {
        const { settings, ui, log } = ctx;
        const temperatureReads = {};
        // Keep the received CDS fields for screenshots; Car remains the existing decoded reader.
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineTemperature(v) {
                ['temperatureEngineOilDrive', 'temperatureEngineDrive'].forEach((field) => {
                    const raw = v && v[field];
                    temperatureReads[field] = { t: Date.now(), bytes: field + '=' + String(raw),
                        ok: num(raw) && raw >= 0 && raw < 255,
                        why: raw == null ? 'missing signal field' : 'invalid signal value' };
                });
            },
        }, log).catch((e) => log.warn('S58 temperature diagnostics: ' + e));
        const car = new Car(ctx, ['rpm', 'temps', 'speed', 'gear']);
        const link = await new ReadOnlyDiag(ctx.signals, log).init();
        const cfg = ctx.spec.config, reader = new DidReader(link, { ecu: cfg.ecu });
        const live = {}, tried = {}, peaks = {}, diagnosticReads = {}, retryUnit = {}, attempts = {};
        let probeNext = 0;
        const units = Array.from(new Set([cfg.ecu].concat(Object.keys(cfg.sources).reduce((a, k) =>
            a.concat(cfg.sources[k].map((c) => c.ecu == null ? cfg.ecu : c.ecu)), []))));
        const retrySeconds = (ecu) => Math.max(0, Math.ceil(((retryUnit[ecu] || Date.now() + RETRY_MS) - Date.now()) / 1000));
        let diagnosticPage = null, monitor = null;
        let source = null, misfireOpen = false;
        const misfire = new Misfire.Debugger({ link, settings, log, dataDir: ctx.dataDir, telemetry: () => {
            const d = car.data(), v = values(), real = !demo() && !d.demo;
            const get = (n) => real && num(n) ? n : null;
            return { rpm: get(d.rpm), speed: get(d.speed), acceleratorPedal: null, throttlePosition: null,
                boost: get(v.boost), engineLoad: null, gear: get(d.gear), gearEstimated: real && d.gearGuessed === true, iat: get(v.iat), coolant: get(v.coolant), ethanolActive: get(v.ethanolActive) };
        } });
        const demo = () => settings.get('demo') === 'on';
        const fresh = (k) => live[k] && Date.now() - live[k].at < STALE_MS ? live[k].value : null;

        async function readEthanol() {
            // MHD Tuning MG1.adx: 6C 88 + 36 bytes; body offset 0x0F is unsigned E%.
            let r;
            monitor = { t: Date.now(), ok: false, bytes: '', why: '' };
            if (link.silent(0x12)) { monitor.why = 'not sent: ECU paused after timeouts'; return null; }
            try {
                r = await link.physical(0x12, 0x2C, [0x88, 0x01], 1500,
                    (u) => (u[0] === 0x6C && u[1] === 0x88) || (u[0] === 0x7F && u[1] === 0x2C));
            } catch (e) { monitor.transport = link.lastPhysical; monitor.why = String(e.message || e); log.warn('MHD monitor: ' + e); return null; }
            monitor.transport = link.lastPhysical;
            if (!r) { monitor.why = 'no reply'; return null; }
            if (!Array.isArray(r) || !r.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
                monitor.bytes = JSON.stringify(r); monitor.why = 'invalid reply bytes'; return null;
            }
            monitor.bytes = r.map((b) => hex(b)).join(' ');
            if (r[0] === 0x7F) { monitor.why = 'NRC ' + hex(r[2]) + ' ' + (NRC[r[2]] || ''); return null; }
            if (r.length !== 38 || r[0] !== 0x6C || r[1] !== 0x88) {
                monitor.why = 'invalid header / length: ' + r.length + ' bytes (expected 38)'; return null;
            }
            if (r[0x11] > 100) { monitor.why = 'out of range: ' + r[0x11] + ' %'; return null; }
            monitor.ok = true;
            return r[0x11];
        }

        async function poll() {
            try {
                if (!demo() && link.available && ui.isVisible('MAIN')) {
                    // ReadOnlyDiag's pause is indefinite until wake(); retry each silent ECU at most once per 30 s.
                    units.forEach((ecu) => {
                        if (link.silent(ecu) && retryUnit[ecu] && Date.now() >= retryUnit[ecu]) {
                            link.wake(ecu); delete retryUnit[ecu];
                            Object.keys(tried).forEach((k) => {
                                if (k === 'ethanolActive' ? ecu === 0x12 : cfg.sources[k].some((c) => (c.ecu == null ? cfg.ecu : c.ecu) === ecu)) { delete tried[k]; delete attempts[k]; }
                            });
                        }
                    });
                    if (settings.get('mhdMonitor') === false) delete live.ethanolActive;
                    const keys = Object.keys(cfg.sources).concat(settings.get('mhdMonitor') === false ? [] : ['ethanolActive']).filter((k) =>
                        (k === 'ethanolActive' || cfg.sources[k].length) && Date.now() >= (tried[k] || 0));
                    // Like Live Data: refresh working readings before one fallback probe, not a whole blocking sweep.
                    const probes = keys.filter((k) => !live[k]);
                    const work = keys.filter((k) => live[k]);
                    if (probes.length) work.push(probes[probeNext++ % probes.length]);
                    for (const k of work) {
                        if (demo() || !ui.isVisible('MAIN')) break;
                        let value, record;
                        if (k === 'ethanolActive') { value = await readEthanol(); record = monitor; }
                        else {
                            const list = cfg.sources[k], i = reader.pick[k] || 0, c = list[i];
                            value = await reader.read(c);
                            record = reader.raws[reader.key(c)];
                            diagnosticReads[k + ':' + i] = Object.assign({}, record);
                            if (!num(value) && !record.why.startsWith('not sent:')) reader.pick[k] = (i + 1) % list.length;
                        }
                        units.forEach((ecu) => { if (link.silent(ecu) && !retryUnit[ecu]) retryUnit[ecu] = Date.now() + RETRY_MS; });
                        if (num(value)) { live[k] = { value, at: Date.now() }; attempts[k] = 0; delete tried[k]; }
                        else {
                            delete live[k];
                            attempts[k] = (attempts[k] || 0) + 1;
                            if (k === 'ethanolActive' || record.why.startsWith('not sent:') || attempts[k] >= cfg.sources[k].length) {
                                tried[k] = Date.now() + RETRY_MS; attempts[k] = 0;
                            }
                        }
                    }
                }
                if (!demo() && ui.isVisible('MAIN')) {
                    await misfire.step();
                    if (link.silent(cfg.ecu) && !retryUnit[cfg.ecu]) retryUnit[cfg.ecu] = Date.now() + RETRY_MS;
                } else if (misfire.monitoring || misfire.jobs.length) misfire.stop('Capture stopped: screen hidden or demo selected');
            } catch (e) { log.warn('S58 readings: ' + e); }
            setTimeout(poll, 500);
        }

        function values() {
            if (demo()) {
                // Illustrative data only, isolated from live samples and labelled DEMO.
                const wave = (period) => (1 + Math.sin(Date.now() / 1000 / period)) / 2;
                const load = wave(2);
                return { boost: 0.1 + load * 2.1, boostTarget: 2.1, wgdc: 58 + load * 36,
                    afr: (1 - load * 0.17) * 14.7, lpfp: 5 + wave(3) * 0.8, rail: 220 + load * 130,
                    knock: [0, -load * 3.4, 0, 0, -load * 3, 0].reduce((sum, v) => sum + Math.abs(v), 0) / 6, iat: 24 + wave(8) * 8, charge: 36 + load * 44,
                    oil: 92, coolant: 87, gearbox: 72, ethanolActive: 17 };
            }
            const abs = fresh('boostAbs'), baro = fresh('baro'), target = fresh('boostTarget'), lambda = fresh('lambda');
            const d = car.data();
            return { boost: num(abs) && num(baro) ? (abs - baro) / 100 : null,
                boostTarget: num(target) && num(baro) ? (target - baro) / 100 : null,
                wgdc: fresh('wgdc'), afr: num(lambda) ? lambda * 14.7 : null,
                lpfp: fresh('lpfp'), rail: fresh('rail'), knock: num(fresh('knock')) ? Math.abs(fresh('knock')) : null,
                iat: fresh('iat'), charge: fresh('charge'), oil: d.demo ? null : d.oil,
                coolant: d.demo ? null : d.coolant, gearbox: fresh('gearbox'), ethanolActive: settings.get('mhdMonitor') === false ? null : fresh('ethanolActive') };
        }

        const clearPeaks = () => { Object.keys(peaks).forEach((k) => delete peaks[k]); };
        const text = (v, decimals) => num(v) ? v.toFixed(decimals) : '--';


        function drawDiagnostics(cv, t) {
            const rows = [];
            const labels = { boostAbs: 'BOOST absolute', baro: 'BOOST ambient', boostTarget: 'BOOST target',
                wgdc: 'WGDC', lambda: 'AFR / lambda', lpfp: 'LPFP', rail: 'RAIL ACTUAL', knock: 'KNK AVG',
                iat: 'IAT', charge: 'CHARGE AIR', gearbox: 'GEARBOX' };
            Object.keys(cfg.sources).forEach((k) => cfg.sources[k].forEach((c, i) => {
                const did = c.did && parseInt(c.did, 16);
                rows.push({ name: labels[k] + ' candidate ' + (i + 1), ecu: hex(c.ecu == null ? cfg.ecu : c.ecu),
                    tx: c.obd ? '01 ' + c.obd : '22 ' + hex(did >> 8) + ' ' + hex(did & 255), r: diagnosticReads[k + ':' + i] });
            }));
            rows.push({ name: 'ETHANOL ACTIVE', ecu: '12', tx: '2C 88 01', r: settings.get('mhdMonitor') === false ? { ok: false, bytes: '', why: 'disabled in Settings' } : monitor });
            const carData = car.data();
            ['oil', 'coolant'].forEach((k) => rows.push({ name: k.toUpperCase(), signal: true,
                tx: 'SOME/IP CDS.statusEngineTemperature.' + (k === 'oil' ? 'temperatureEngineOilDrive' : 'temperatureEngineDrive'),
                r: temperatureReads[k === 'oil' ? 'temperatureEngineOilDrive' : 'temperatureEngineDrive'],
                value: carData.demo ? null : carData[k] }));
            const count = Math.ceil(rows.length / 3);
            diagnosticPage = (diagnosticPage + count) % count;
            cv.text('S58 OVERVIEW / DIAGNOSTICS   ' + (diagnosticPage + 1) + ' / ' + count, 24, 64, 23, t.text, { font: 'bold' });
            const state = demo() ? 'DEMO: requests paused; no ECU replies shown' :
                'TASU: ' + (link.available ? 'available' : (link.error || 'unavailable')) + ' | sent ' + link.stats.sent + ' / timeout ' + link.stats.missed + ' / busy ' + (link.busy || 0)
                + (link.silent(cfg.ecu) ? ' | DME paused; retry in ' + retrySeconds(cfg.ecu) + ' s' : ' | Read-only');
            cv.text(state, 24, 94, 19, demo() || !link.available ? t.warn : t.dim);
            rows.slice(diagnosticPage * 3, diagnosticPage * 3 + 3).forEach((row, i) => {
                const y = 128 + i * 120, r = demo() ? null : row.r;
                const age = r && num(r.t) ? Math.max(0, (Date.now() - r.t) / 1000).toFixed(1) + ' s' : '--';
                let status = demo() ? 'DEMO: requests paused' : row.signal ? (!r ? 'no signal received' : !r.ok ? r.why : 'OK (SOME/IP notification; age since last change)') :
                    !r ? 'NOT READ' : !r.ok ? r.why : Date.now() - r.t >= STALE_MS ? 'STALE (older than 10 s)' : 'OK';
                if (!demo() && !row.signal && link.silent(parseInt(row.ecu, 16))) status += ' | ECU paused; retry in ' + retrySeconds(parseInt(row.ecu, 16)) + ' s';
                cv.fillRect(16, y - 23, 1568, 114, '#15171c');
                cv.text(row.name + (row.signal ? '' : ' | ECU 0x' + row.ecu) + ' | age ' + age, 28, y, 21, t.text, { font: 'bold' });
                cv.text((row.signal ? 'SOURCE ' : 'TX ') + row.tx, 28, y + 23, 18, t.dim);
                const raw = demo() ? '--' : row.signal ? (r ? r.bytes : '--') + '; decoded=' + text(row.value, 1) + ' C' : r && r.bytes || '--';
                cv.text('RX ' + raw.slice(0, 100), 28, y + 45, 18, t.text);
                if (raw.length > 100) cv.text('   ' + raw.slice(100), 28, y + 65, 18, t.text);
                else if (r && r.transport) {
                    const tr = r.transport;
                    const detail = tr.ms + ' ms | TASU verdict ' + tr.verdict + ' | pending ' + tr.pending
                        + (tr.events.length ? ' | observed: ' + tr.events.join(', ') : tr.unmatched ? ' | unmatched RX ' + tr.unmatched : '');
                    cv.text(detail.slice(0, 155), 28, y + 65, 18, tr.events.length ? t.warn : t.dim);
                }
                cv.text(status.slice(0, 155), 28, y + 86, 18, status.startsWith('OK') ? t.dim : t.warn);
            });
            G.button(cv, t, 1260, 52, 310, 38, 'Misfire Debugger', () => { misfireOpen = true; });
            G.button(cv, t, 24, 465, 300, 40, 'Previous diagnostics', () => { diagnosticPage--; });
            G.button(cv, t, 340, 465, 300, 40, 'Next diagnostics', () => { diagnosticPage++; });
            cv.text('TX = request / RX = reply; all fallback candidates included', 680, 491, 18, t.dim);
        }

        function render() {
            const isDemo = demo();
            if (source !== isDemo) { clearPeaks(); Object.keys(live).forEach((k) => delete live[k]); source = isDemo; if (isDemo) { Object.keys(diagnosticReads).forEach((k) => delete diagnosticReads[k]); monitor = null; } }
            const d = values(), t = ctx.theme(), cv = ctx.canvas(W, H).clear('#08090b');
            G.frame(cv, t, ['Overview', 'Diagnostics', 'Misfire Debugger'], misfireOpen ? 2 : diagnosticPage !== null ? 1 : 0);
            if (misfireOpen) { Misfire.draw(cv, t, misfire, () => { misfireOpen = false; diagnosticPage = 0; }); return ui.image('MAIN_GFX', cv); }
            if (diagnosticPage !== null) { drawDiagnostics(cv, t); return ui.image('MAIN_GFX', cv); }
            Object.keys(d).forEach((k) => {
                if (!num(d[k])) return;
                const p = peaks[k] || (peaks[k] = { min: d[k], max: d[k] });
                p.min = Math.min(p.min, d[k]); p.max = Math.max(p.max, d[k]);
            });
            cv.text(isDemo ? 'DEMO - SIMULATED DATA' : 'S58 ENGINE OVERVIEW', 24, 65, 21, isDemo ? t.warn : t.dim, { font: 'bold', spacing: 1 });
            const paused = !isDemo && link.silent(cfg.ecu);
            cv.text(paused ? 'DME paused - retry in ' + retrySeconds(cfg.ecu) + ' s' : 'PRESSURES IN BAR', 1576, 65, 18, paused ? t.warn : t.dim, { align: 'right' });

            G.radial(cv, t, 190, 236, 172, { value: d.boost, min: 0, max: settings.get('boostMax'), decimals: 2,
                ticks: 12, tickDecimals: 1, label: 'Boost', unit: 'bar', hot: false, color: '#ee293d', showPeak: false,
                peak: peaks.boost && peaks.boost.max });
            cv.text('MAX ' + text(peaks.boost && peaks.boost.max, 2) + '  /  TARGET ' + text(d.boostTarget, 2), 190, 438, 18, t.dim, { align: 'center' });

            const gauges = [
                ['wgdc', 'WGDC', '%', 100, 0], ['afr', 'AFR', '', 24, 2],
                ['lpfp', 'LPFP', 'bar', 8, 2], ['rail', 'RAIL ACTUAL', 'bar', 400, 0], ['knock', 'KNK AVG', '°', 6, 1],
            ];
            gauges.forEach(([key, label, unit, max, decimals], i) => {
                const x = 496 + i * 244;
                cv.text(label, x, 92, 23, t.text, { align: 'center', font: 'bold' });
                G.radial(cv, t, x, 236, 107, { value: d[key], min: 0, max, decimals, unit,
                    ticks: 10, tickLabels: false, hot: false, color: '#ee293d', showPeak: false });
                const p = peaks[key];
                cv.text('MIN ' + text(p && p.min, decimals) + '  MAX ' + text(p && p.max, decimals), x, 386, 18, t.dim, { align: 'center' });
                const note = key === 'afr' ? 'gasoline scale' : key === 'knock' ? 'ECU mean retard' : key === 'rail' ? 'ECU rail pressure' : '';
                if (note) cv.text(note, x, 414, 18, t.dim, { align: 'center' });
            });

            const bottom = G.pageBottom(cv);
            cv.fillRect(0, 454, W, Math.max(66, bottom - 454), '#15171c');
            const strip = [['iat', 'IAT', '°C'], ['charge', 'CHARGE AIR', '°C'], ['oil', 'OIL', '°C'],
                ['coolant', 'COOLANT', '°C'], ['gearbox', 'GEARBOX', '°C'], ['ethanolActive', 'ETHANOL ACTIVE', '%']];
            strip.forEach(([key, label, unit], i) => {
                const x = 28 + i * 264;
                cv.text(label, x, 476, 17, t.dim, { font: 'bold' });
                cv.text(text(d[key], 0) + ' ' + unit, x, 509, 32, num(d[key]) ? t.text : t.dim, { font: 'bold' });
            });
            return ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_DIAG', () => { misfireOpen = false; diagnosticPage = diagnosticPage === null ? 0 : null; return render(); });
        ui.onClick('BTN_DIAG_NEXT', () => { if (misfireOpen) { misfire.page++; return render(); } diagnosticPage = diagnosticPage === null ? 0 : diagnosticPage + 1; return render(); });
        ui.onClick('BTN_DIAG_PREV', () => { if (misfireOpen) { misfire.page--; return render(); } diagnosticPage = diagnosticPage === null ? 0 : diagnosticPage - 1; return render(); });
        ui.onClick('BTN_MISFIRE', () => { misfireOpen = !misfireOpen; if (!misfireOpen) diagnosticPage = 0; return render(); });
        ui.onClick('BTN_MF_ACTION', async () => {
            if (!misfireOpen) { misfireOpen = true; misfire.message = 'Choose Misfire action in Settings; press Run misfire action'; }
            else if (settings.get('misfireAction') === 'back') { misfireOpen = false; diagnosticPage = 0; }
            else { try { await misfire.action(settings.get('misfireAction') || 'refresh'); } catch (e) { misfire.message = String(e.message || e); } }
            return render();
        });
        ctx.onTab((i) => { misfireOpen = i === 2; diagnosticPage = i === 1 ? 0 : null; return render(); });
        ui.onVisible((name, on) => { if (name === 'MAIN' && !on) misfire.stop('Capture stopped: app hidden'); });
        ui.onClick('BTN_RESET', () => { clearPeaks(); return render(); });
        settings.onChange((key) => { if (/^misfire/.test(key) && key !== 'misfireAction') misfire.stop('Debugger settings changed; refresh or start monitoring'); clearPeaks(); link.wake(); Object.keys(retryUnit).forEach((k) => delete retryUnit[k]); Object.keys(tried).forEach((k) => delete tried[k]); });
        ctx.loop('MAIN', 30, render);
        await render();
        poll();
    },
});
