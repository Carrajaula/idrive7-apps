'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const { hex, NRC } = require('./kit/diag');

const W = 1600, H = 520, STALE_MS = 10000;
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
        const car = new Car(ctx, ['rpm', 'temps']);
        const link = await new ReadOnlyDiag(ctx.signals, log).init();
        const cfg = ctx.spec.config, reader = new DidReader(link, { ecu: cfg.ecu });
        const live = {}, tried = {}, peaks = {}, diagnosticReads = {};
        let diagnosticPage = null, monitor = null;
        let source = null;
        const demo = () => settings.get('demo') === 'on';
        const fresh = (k) => live[k] && Date.now() - live[k].at < STALE_MS ? live[k].value : null;

        async function readEthanol() {
            // MHD Tuning MG1.adx: 6C 88 + 36 bytes; body offset 0x0F is unsigned E%.
            let r;
            monitor = { t: Date.now(), ok: false, bytes: '', why: '' };
            try {
                r = await link.physical(0x12, 0x2C, [0x88, 0x01], 1200,
                    (u) => (u[0] === 0x6C && u[1] === 0x88) || (u[0] === 0x7F && u[1] === 0x2C));
            } catch (e) { monitor.why = String(e.message || e); log.warn('MHD monitor: ' + e); return null; }
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
                    for (const k of Object.keys(cfg.sources).concat('ethanolActive')) {
                        if (demo() || !ui.isVisible('MAIN')) break;
                        if ((k !== 'ethanolActive' && !cfg.sources[k].length) || Date.now() < (tried[k] || 0)) continue;
                        const started = Date.now();
                        const value = k === 'ethanolActive' ? await readEthanol() : await reader.value(k, cfg.sources[k]);
                        if (k !== 'ethanolActive') cfg.sources[k].forEach((c, i) => {
                            const r = reader.raws[reader.key(c)];
                            if (r && r.t >= started) diagnosticReads[k + ':' + i] = Object.assign({}, r);
                        });
                        if (num(value)) live[k] = { value, at: Date.now() };
                        else { delete live[k]; tried[k] = Date.now() + 30000; }
                    }
                }
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
                coolant: d.demo ? null : d.coolant, gearbox: fresh('gearbox'), ethanolActive: fresh('ethanolActive') };
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
            rows.push({ name: 'ETHANOL ACTIVE', ecu: '12', tx: '2C 88 01', r: monitor });
            const carData = car.data();
            ['oil', 'coolant'].forEach((k) => rows.push({ name: k.toUpperCase(), signal: true,
                tx: 'SOME/IP CDS.statusEngineTemperature.' + (k === 'oil' ? 'temperatureEngineOilDrive' : 'temperatureEngineDrive'),
                r: temperatureReads[k === 'oil' ? 'temperatureEngineOilDrive' : 'temperatureEngineDrive'],
                value: carData.demo ? null : carData[k] }));
            const count = Math.ceil(rows.length / 3);
            diagnosticPage = (diagnosticPage + count) % count;
            cv.text('S58 OVERVIEW / DIAGNOSTICS   ' + (diagnosticPage + 1) + ' / ' + count, 24, 64, 23, t.text, { font: 'bold' });
            const state = demo() ? 'DEMO: requests paused; no ECU replies shown' :
                'TASU: ' + (link.available ? 'available' : (link.error || 'unavailable')) + ' | Read-only | Raw UDS bytes';
            cv.text(state, 24, 94, 19, demo() || !link.available ? t.warn : t.dim);
            rows.slice(diagnosticPage * 3, diagnosticPage * 3 + 3).forEach((row, i) => {
                const y = 128 + i * 120, r = demo() ? null : row.r;
                const age = r ? Math.max(0, (Date.now() - r.t) / 1000).toFixed(1) + ' s' : '--';
                const status = demo() ? 'DEMO: requests paused' : row.signal ? (!r ? 'no signal received' : !r.ok ? r.why : 'OK (SOME/IP notification; age since last change)') :
                    !r ? 'NOT READ' : !r.ok ? r.why : Date.now() - r.t >= STALE_MS ? 'STALE (older than 10 s)' : 'OK';
                cv.fillRect(16, y - 23, 1568, 114, '#15171c');
                cv.text(row.name + (row.signal ? '' : ' | ECU 0x' + row.ecu) + ' | age ' + age, 28, y, 21, t.text, { font: 'bold' });
                cv.text((row.signal ? 'SOURCE ' : 'TX ') + row.tx, 28, y + 23, 18, t.dim);
                const raw = demo() ? '--' : row.signal ? (r ? r.bytes : '--') + '; decoded=' + text(row.value, 1) + ' C' : r && r.bytes || '--';
                cv.text('RX ' + raw.slice(0, 100), 28, y + 45, 18, t.text);
                if (raw.length > 100) cv.text('   ' + raw.slice(100), 28, y + 65, 18, t.text);
                cv.text(status.slice(0, 155), 28, y + 86, 18, status.startsWith('OK') ? t.dim : t.warn);
            });
            cv.text('Previous / Next diagnostics: all candidates | Diagnostics / Overview: return to gauges', 24, 509, 18, t.dim);
        }

        function render() {
            const isDemo = demo();
            if (source !== isDemo) { clearPeaks(); Object.keys(live).forEach((k) => delete live[k]); source = isDemo; if (isDemo) { Object.keys(diagnosticReads).forEach((k) => delete diagnosticReads[k]); monitor = null; } }
            const d = values(), t = ctx.theme(), cv = ctx.canvas(W, H).clear('#08090b');
            if (diagnosticPage !== null) { drawDiagnostics(cv, t); return ui.image('MAIN_GFX', cv); }
            Object.keys(d).forEach((k) => {
                if (!num(d[k])) return;
                const p = peaks[k] || (peaks[k] = { min: d[k], max: d[k] });
                p.min = Math.min(p.min, d[k]); p.max = Math.max(p.max, d[k]);
            });
            cv.text(isDemo ? 'DEMO - SIMULATED DATA' : 'S58 ENGINE OVERVIEW', 24, 65, 21, isDemo ? t.warn : t.dim, { font: 'bold', spacing: 1 });
            cv.text('PRESSURES IN BAR', 1576, 65, 18, t.dim, { align: 'right' });

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

        ui.onClick('BTN_DIAG', () => { diagnosticPage = diagnosticPage === null ? 0 : null; return render(); });
        ui.onClick('BTN_DIAG_NEXT', () => { diagnosticPage = diagnosticPage === null ? 0 : diagnosticPage + 1; return render(); });
        ui.onClick('BTN_DIAG_PREV', () => { diagnosticPage = diagnosticPage === null ? 0 : diagnosticPage - 1; return render(); });
        ui.onClick('BTN_RESET', () => { clearPeaks(); return render(); });
        settings.onChange(() => { clearPeaks(); link.wake(); Object.keys(tried).forEach((k) => delete tried[k]); });
        ctx.loop('MAIN', 30, render);
        await render();
        poll();
    },
});
