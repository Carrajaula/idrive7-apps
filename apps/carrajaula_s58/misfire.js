'use strict';

const fs = require('fs');
const path = require('path');
const { hex, NRC } = require('./kit/diag');
const G = require('./kit/gauges');
const byte = (b) => Number.isInteger(b) && b >= 0 && b <= 255;
const num = (v) => typeof v === 'number' && isFinite(v);
const iso = (t) => new Date(t).toISOString();
const MIDS = [0xA0, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7];
const SOURCE = 'SAE J1979-DA OCT2011, tables C2, D1 and E1-E4/E36; S58 compatibility unverified';

// Only definitions actually checked in the SAE annex. Unknown identifiers stay raw.
function scale(id, raw) {
    const definitions = { 1: [1, 'raw'], 2: [0.1, 'raw'], 3: [0.01, 'raw'], 4: [0.001, 'raw'], 0x24: [1, 'counts'] };
    const d = definitions[id];
    return d ? { known: true, value: raw * d[0], unit: d[1], factor: d[0] } : { known: false, value: null, unit: null, factor: null };
}

function parse(protocol, mid, response, selectedTid) {
    const result = { protocol, requestedMid: mid, selectedTid: selectedTid == null ? 0x0C : selectedTid,
        rawResponse: Array.isArray(response) ? response.slice() : response, responseHex: '', tests: [], selected: null,
        status: 'malformed', interpretationVerified: false, layout: protocol === 'uds' ? 'candidate F6 layout; not S58 verified' : 'SAE Mode 06 layout; S58 compatibility unverified' };
    if (response == null) { result.status = 'timeout'; return result; }
    if (!Array.isArray(response) || !response.every(byte)) { result.error = 'invalid response bytes'; return result; }
    result.responseHex = response.map((b) => hex(b)).join(' ');
    const sid = protocol === 'mode06' ? 6 : 0x22;
    if (response[0] === 0x7F) {
        if (response.length !== 3 || response[1] !== sid) { result.error = 'wrong or truncated negative response'; return result; }
        result.nrc = response[2]; result.error = NRC[result.nrc] || 'unknown NRC';
        result.status = [0x11, 0x12, 0x31].indexOf(result.nrc) >= 0 ? 'unsupported' : 'negative response'; return result;
    }
    const isUds = protocol === 'uds', at = isUds ? 3 : 1, size = isUds ? 8 : 9;
    if ((protocol !== 'uds' && protocol !== 'mode06') || response[0] !== sid + 0x40 || (isUds && response[1] !== 0xF6)) {
        result.error = 'unexpected positive response header'; return result;
    }
    result.returnedMid = response[isUds ? 2 : 1];
    if (mid === 0xA0) {
        if (response.length !== at + (isUds ? 4 : 5) || result.returnedMid !== mid) {
            result.error = 'wrong support MID or bitmap length'; return result;
        }
        const offset = isUds ? 3 : 2;
        result.supported = [];
        for (let i = 0; i < 32; i++) if (response[offset + (i >> 3)] & (0x80 >> (i & 7))) result.supported.push(mid + 1 + i);
        result.status = 'parsed'; return result;
    }
    let wrongMid = false;
    for (let i = at; i + size <= response.length; i += size) {
        const returnedMid = isUds ? response[2] : response[i], o = isUds ? i : i + 1;
        const tid = response[o], uasid = response[o + 1];
        const value = response[o + 2] * 256 + response[o + 3];
        const minimum = response[o + 4] * 256 + response[o + 5], maximum = response[o + 6] * 256 + response[o + 7];
        const scaling = scale(uasid, value);
        wrongMid = wrongMid || returnedMid !== mid;
        result.tests.push({ returnedMid, tid, uasid, rawValue: value, scaledValue: scaling.value, unit: scaling.unit,
            minimum, maximum, scaledMinimum: scale(uasid, minimum).value, scaledMaximum: scale(uasid, maximum).value,
            status: returnedMid !== mid ? 'wrong MID' : minimum > maximum ? 'invalid limits' : !scaling.known ? 'unknown UASID' : value < minimum || value > maximum ? 'outside limits' : 'parsed; semantics unverified',
            definition: mid >= 0xA2 && mid <= 0xA7 && uasid === 0x24 ? tid === 0x0C ? 'last/current driving cycles, calculated rounded count' : tid === 0x0B ? 'previous driving cycles EWMA, calculated rounded count' : null : null,
            interpretationVerified: false });
    }
    if (response.length <= at || (response.length - at) % size !== 0) {
        result.trailingBytes = response.slice(at + result.tests.length * size); result.error = 'incomplete monitor record'; return result;
    }
    if (wrongMid) { result.status = 'wrong MID'; return result; }
    const matches = result.tests.filter((t) => t.tid === result.selectedTid);
    if (matches.length !== 1) { result.status = 'ambiguous'; result.error = matches.length ? 'duplicate selected TID' : 'selected TID absent; no substitution'; return result; }
    result.selected = matches[0]; result.status = 'parsed'; return result;
}

function classify(t, previous) {
    if (!num(t.speed) || !num(t.rpm)) return 'unknown';
    if (t.speed < 0.5 && t.rpm >= 400 && t.rpm <= 1200) return 'idle';
    if (num(t.engineLoad) && t.engineLoad >= 80) return 'high load';
    if (!previous || !num(previous.speed) || !(previous.elapsed > 0 && previous.elapsed <= 30)) return 'unknown';
    const rate = (t.speed - previous.speed) / previous.elapsed;
    if (rate > 2) return 'acceleration';
    if (rate < -2) return 'deceleration';
    return t.speed > 10 && Math.abs(rate) < 0.5 ? 'steady cruising' : 'unknown';
}

const write = (file, data, append) => new Promise((resolve, reject) => fs[append ? 'appendFile' : 'writeFile'](file, data, 'utf8', (e) => e ? reject(e) : resolve()));
const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

class Debugger {
    constructor(o) {
        Object.assign(this, o);
        this.mode = null; this.preference = null; this.jobs = []; this.busy = false; this.monitoring = false;
        this.generation = 0; this.round = 0; this.nextPoll = 0; this.lastSuccess = null;
        this.records = []; this.events = []; this.latest = {}; this.inspections = {}; this.tids = {}; this.previous = {}; this.baselines = {};
        this.selectedMid = 0xA2; this.inspector = false; this.page = 0; this.message = 'No S58 monitor captures yet; interpretation UNVERIFIED';
        this.session = iso(Date.now()).replace(/[:.]/g, '-');
        this.captureFile = this.dataDir ? path.join(this.dataDir, 'misfire-' + this.session + '.jsonl') : null;
        this.writeChain = Promise.resolve(); this.lastTelemetry = null;
    }
    getSetting(k, fallback) { const v = this.settings.get(k); return v == null ? fallback : v; }
    timeout() { return Math.max(1, Math.min(10, Number(this.getSetting('misfireTimeout', 4)) || 4)) * 1000; }
    interval() { return Math.max(5, Math.min(120, Number(this.getSetting('misfireInterval', 10)) || 10)) * 1000; }
    stationary() { const s = this.telemetry().speed; return num(s) && s >= 0 && s < 0.5; }
    stop(reason) { this.monitoring = false; this.jobs = []; this.generation++; this.message = reason || 'Monitoring stopped; captured data retained'; }
    start() { if (!this.stationary()) { this.message = 'Start while stationary with a valid speed signal'; return false; } this.monitoring = true; return this.refresh(); }
    refresh(mid) {
        if (!this.stationary()) { this.message = 'Manual request requires stationary vehicle and valid speed'; return false; }
        this.generation++; this.queue(mid); return true;
    }
    queue(mid) {
        const preference = this.getSetting('misfireProtocol', 'auto');
        if (preference !== this.preference) { this.mode = null; this.preference = preference; }
        const desired = mid == null ? MIDS : [mid];
        if (desired.some((m) => MIDS.indexOf(m) < 0)) throw new Error('unsupported inspector MID');
        // A scan, like Live Data's Read all, clears only the local pause once (no ECU command).
        this.link.wake(0x12);
        this.round++;
        const mode = preference === 'auto' ? this.mode : preference;
        if (!mode) this.jobs = [{ protocol: 'mode06', mid: 0xA2, probe: true, desired, round: this.round }];
        else this.jobs = desired.map((m) => ({ protocol: mode, mid: m, round: this.round }));
        this.nextPoll = Date.now() + this.interval();
    }
    selectTid(mid, tid) {
        if (!byte(tid) || MIDS.indexOf(mid) < 0) throw new Error('bad selected TID');
        this.tids[mid] = tid; this.page = 0;
        this.message = 'Manual inspection TID ' + hex(tid) + '; not confirmed as misfires';
    }
    action(name) {
        if (name === 'refresh') return this.refresh(this.inspector ? this.selectedMid : undefined);
        if (name === 'monitor') return this.monitoring ? this.stop() : this.start();
        if (name === 'baseline') return this.resetBaseline();
        if (name === 'export') return this.export();
        if (!this.stationary()) { this.message = 'Detailed inspection requires a stationary vehicle'; return false; }
        if (name === 'inspector') { this.inspector = !this.inspector; this.page = 0; }
        else if (name === 'nextmid') { this.selectedMid = MIDS[(MIDS.indexOf(this.selectedMid) + 1) % MIDS.length]; this.page = 0; }
        else if (name === 'nexttid') {
            const pref = this.getSetting('misfireProtocol', 'auto'), mode = pref === 'auto' ? this.mode || (this.last && this.last.protocol) || 'mode06' : pref;
            const r = this.inspections[mode + ':' + this.selectedMid], tids = r ? Array.from(new Set(r.parsed.tests.map((t) => t.tid))) : [];
            if (tids.length) { const old = this.tids[this.selectedMid] == null ? 12 : this.tids[this.selectedMid]; this.selectTid(this.selectedMid, tids[(tids.indexOf(old) + 1) % tids.length]); }
            else this.message = 'No returned TIDs to select';
        } else if (name === 'previous') this.page--;
        else if (name === 'next') this.page++;
        else this.message = 'Unknown debugger action';
        return true;
    }
    resetBaseline() {
        if (!this.stationary()) { this.message = 'Reset local baseline while stationary'; return false; }
        this.baselines = {};
        Object.keys(this.latest).forEach((mid) => {
            const r = this.latest[mid], tid = this.tids[mid] == null ? 12 : this.tids[mid], parsed = parse(r.protocol, Number(mid), r.rawResponse, tid), s = parsed.selected;
            if (r.status === 'parsed' && parsed.status === 'parsed' && s && s.status.indexOf('parsed') === 0) this.baselines[mid] = { raw: s.rawValue, signature: r.protocol + ':' + mid + ':' + s.tid + ':' + s.uasid, at: iso(Date.now()) };
        });
        const event = { timestampUtc: iso(Date.now()), action: 'local baseline reset', baselines: JSON.parse(JSON.stringify(this.baselines)) };
        this.events.push(event); this.log.info('misfire-debug ' + JSON.stringify(event));
        if (this.captureFile) this.writeChain = this.writeChain.then(() => write(this.captureFile, JSON.stringify(event) + '\n', true)).catch((e) => { this.message = 'Capture write failed: ' + e; });
        this.message = 'Local baseline reset; no DME command sent'; return true;
    }
    async step() {
        if (this.busy) return false;
        if (!this.jobs.length && this.monitoring && Date.now() >= this.nextPoll) this.queue();
        if (!this.jobs.length) return false;
        // ponytail: retain up to 5000 complete records in memory; stop rather than discard evidence. Stream JSONL for longer offline retention.
        if (this.records.length >= 5000) { this.stop('Capture limit 5000 reached; export and restart the app for a new capture'); return false; }
        const job = this.jobs.shift(), gen = this.generation, began = Date.now(), timeout = this.timeout();
        const sid = job.protocol === 'mode06' ? 6 : 0x22, data = sid === 6 ? [job.mid] : [0xF6, job.mid];
        const requestHex = [sid].concat(data).map((b) => hex(b)).join(' ');
        this.busy = true;
        let response = null, error = null, transport = null, state = null;
        try {
            if (!this.link.available) state = 'disconnected';
            else if (this.link.silent(0x12)) state = 'not sent: ECU paused';
            else {
                const accept = (u) => (u[0] === 0x7F && u[1] === sid) || (sid === 6 ? u[0] === 0x46 && u[1] === job.mid : u[0] === 0x62 && u[1] === 0xF6 && u[2] === job.mid);
                try { response = await this.link.physical(0x12, sid, data, timeout, accept, { hardTimeoutMs: timeout, pendingTimeoutMs: timeout, callTimeoutMs: timeout, maxRetries: 0 }); } catch (e) { error = String(e.message || e); state = 'transport error'; }
                const tr = this.link.lastPhysical;
                if (tr && tr.ecu === 0x12 && tr.request === requestHex && tr.at >= began) transport = Object.assign({}, tr);
                if (response === undefined) state = 'cancelled before send';
            }
            const ended = Date.now(), selectedTid = this.tids[job.mid] == null ? 0x0C : this.tids[job.mid];
            const parsed = parse(job.protocol, job.mid, response, selectedTid);
            const telemetry = Object.assign({}, this.telemetry());
            const previousTelemetry = this.lastTelemetry && { speed: this.lastTelemetry.speed, elapsed: (ended - this.lastTelemetry.at) / 1000 };
            const record = { timestampUtc: iso(ended), requestTimestampUtc: iso(transport ? transport.at : began), responseTimestampUtc: response == null ? null : iso(ended),
                durationMs: transport ? transport.ms : ended - began, timeoutMs: timeout, dmeAddress: '0x12', protocol: job.protocol,
                requestHex, responseHex: parsed.responseHex || null, rawResponse: parsed.rawResponse, cylinder: job.mid >= 0xA2 ? job.mid - 0xA1 : null,
                requestedMid: job.mid, returnedMid: parsed.returnedMid == null ? null : parsed.returnedMid, selectedTid,
                interpretationVerified: false, status: gen !== this.generation ? 'cancelled' : state || parsed.status,
                error: error || parsed.error || null, nrc: parsed.nrc == null ? null : parsed.nrc, parsed, transport,
                telemetry, operatingCondition: classify(telemetry, previousTelemetry), round: job.round, rawDelta: null, rawSinceBaseline: null, change: 'no comparable previous sample' };
            this.lastTelemetry = Object.assign({ at: ended }, telemetry);
            if (gen === this.generation && !state) {
                const s = parsed.selected, prev = this.previous[job.mid];
                if (parsed.status === 'parsed' && s && s.status.indexOf('parsed') === 0) {
                    record.signature = job.protocol + ':' + job.mid + ':' + s.tid + ':' + s.uasid;
                    if (prev && prev.signature === record.signature) {
                        if (s.rawValue < prev.raw) { record.change = 'decrease: possible reset, cycle transition or semantics change'; delete this.baselines[job.mid]; }
                        else { record.rawDelta = s.rawValue - prev.raw; record.change = 'raw difference only; cumulative behavior unverified'; }
                    }
                    const base = this.baselines[job.mid];
                    if (base && base.signature === record.signature && s.rawValue >= base.raw) record.rawSinceBaseline = s.rawValue - base.raw;
                    this.previous[job.mid] = { raw: s.rawValue, signature: record.signature };
                }
                if (parsed.status === 'parsed' || parsed.status === 'ambiguous') this.lastSuccess = record.timestampUtc;
            }
            if (gen === this.generation) this.latest[job.mid] = record;
            this.records.push(record); this.inspections[job.protocol + ':' + job.mid] = record; this.last = record;
            this.log.info('misfire-debug ' + JSON.stringify(record));
            if (this.captureFile) this.writeChain = this.writeChain.then(() => write(this.captureFile, JSON.stringify(record) + '\n', true)).catch((e) => { this.message = 'Capture write failed: ' + e; });
            if (gen === this.generation && job.probe && !state) {
                const usable = parsed.status === 'parsed' || parsed.status === 'ambiguous';
                if (usable) { this.mode = job.protocol; this.jobs = job.desired.map((mid) => ({ protocol: job.protocol, mid, round: job.round })); }
                else if (job.protocol === 'mode06') this.jobs = [Object.assign({}, job, { protocol: 'uds' })];
                else this.message = 'Both detection probes failed; inspect raw captures';
            }
            if (!this.jobs.length) this.nextPoll = Date.now() + this.interval();
            return true;
        } finally { this.busy = false; }
    }
    summary() {
        const rows = MIDS.slice(1).map((m) => this.latest[m]);
        const valid = rows.every((r) => r && r.status === 'parsed' && r.parsed.selected && r.parsed.selected.status.indexOf('parsed') === 0
            && r.protocol === rows[0].protocol && r.round === rows[0].round && r.selectedTid === rows[0].selectedTid && (this.tids[r.requestedMid] == null ? 12 : this.tids[r.requestedMid]) === r.selectedTid
            && r.parsed.selected.uasid === rows[0].parsed.selected.uasid);
        return { rawSum: valid ? rows.reduce((s, r) => s + r.parsed.selected.rawValue, 0) : null, misfireCount: null, interpretationVerified: false };
    }
    flush() { return this.writeChain; }
    async export() {
        if (!this.stationary()) throw new Error('Export requires stationary vehicle and valid speed');
        if (!this.dataDir) throw new Error('No writable app data directory');
        if (this.exporting) throw new Error('Export already running');
        this.exporting = true;
        try {
            const records = this.records.slice(), base = path.join(this.dataDir, 'misfire-export-' + iso(Date.now()).replace(/[:.]/g, '-'));
            const columns = ['timestampUtc','requestTimestampUtc','responseTimestampUtc','durationMs','timeoutMs','dmeAddress','protocol','requestHex','responseHex','rawResponse','cylinder','requestedMid','returnedMid','selectedTid','tid','uasid','rawValue','scaledValue','unit','minimum','maximum','interpretationVerified','status','error','rawDelta','rawSinceBaseline','change','operatingCondition','telemetry','transport'];
            const lines = [columns.join(',')];
            records.forEach((r) => (r.parsed.tests.length ? r.parsed.tests : [null]).forEach((t) => {
                const row = Object.assign({}, r, t || {}, { status: r.status + (t ? '; ' + t.status : ''), rawResponse: JSON.stringify(r.rawResponse), telemetry: JSON.stringify(r.telemetry), transport: JSON.stringify(r.transport) });
                lines.push(columns.map((k) => csvCell(row[k])).join(','));
            }));
            await write(base + '.json', JSON.stringify({ schema: 1, session: this.session, source: SOURCE, s58CompatibilityVerified: false, events: this.events.slice(), records }, null, 2));
            await write(base + '.csv', lines.join('\r\n') + '\r\n');
            this.exported = { json: base + '.json', csv: base + '.csv' };
            this.message = 'Exported ' + records.length + ' requests to ' + path.basename(base) + '.json / .csv';
            return this.exported;
        } finally { this.exporting = false; }
    }
}

function inspectorLines(d) {
    const preference = d.getSetting('misfireProtocol', 'auto'), mode = preference === 'auto' ? d.mode || (d.last && d.last.protocol) || 'mode06' : preference;
    const r = d.inspections[mode + ':' + d.selectedMid];
    const tid = d.tids[d.selectedMid] == null ? 0x0C : d.tids[d.selectedMid];
    if (!r) return ['No response captured for ' + mode + ' MID ' + hex(d.selectedMid), 'Use Read selected MID. Default selected TID: ' + hex(tid), 'Protocol / timeout / interval can be changed in Settings.'];
    const parsed = parse(r.protocol, r.requestedMid, r.rawResponse, tid);
    const lines = ['TX ' + r.requestHex + ' | DME ' + r.dmeAddress + ' | timeout ' + r.timeoutMs + ' ms',
        'Requested ' + r.requestTimestampUtc + ' | replied ' + (r.responseTimestampUtc || '--') + ' | latency ' + r.durationMs + ' ms',
        'STATUS ' + r.status + (r.nrc == null ? '' : ' NRC ' + hex(r.nrc)) + (r.error ? ' | ' + r.error : ''),
        'Requested MID ' + hex(r.requestedMid) + ' | returned ' + (parsed.returnedMid == null ? '--' : hex(parsed.returnedMid)) + ' | inspection TID ' + hex(tid),
        'Selection: ' + parsed.status + (parsed.error ? ' | ' + parsed.error : '') + ' | interpretation UNVERIFIED',
        'RX ' + (r.responseHex || (r.rawResponse == null ? '--' : JSON.stringify(r.rawResponse)))];
    if (parsed.supported) lines.push('Supported MIDs: ' + (parsed.supported.map((m) => hex(m)).join(' ') || 'none'));
    parsed.tests.forEach((t) => {
        lines.push('MID ' + hex(t.returnedMid) + ' TID ' + hex(t.tid) + ' UASID ' + hex(t.uasid) + ' raw=' + t.rawValue + ' min=' + t.minimum + ' max=' + t.maximum);
        lines.push('Scaled=' + (t.scaledValue == null ? 'UNKNOWN UASID; raw only' : t.scaledValue + ' ' + t.unit) + ' | ' + t.status);
        if (t.definition) lines.push('SAE definition: ' + t.definition + '; S58 semantics unverified');
    });
    if (parsed.trailingBytes) lines.push('Unparsed trailing bytes: ' + parsed.trailingBytes.map((b) => hex(b)).join(' '));
    lines.push(parsed.layout);
    if (r.transport) {
        lines.push('TASU ' + r.transport.verdict + ' | pending=' + r.transport.pending + ' | observed ' + r.transport.events.join(', '));
        if (r.transport.unmatched) lines.push('Observed unmatched RX (not attributed to this request): ' + r.transport.unmatched);
    }
    lines.push('Snapshot at reply receipt: ' + JSON.stringify(r.telemetry));
    lines.push('Condition (heuristic): ' + r.operatingCondition + ' | ' + r.change);
    if (d.exported) lines.push('Exports: ' + d.exported.json, d.exported.csv);
    const wrapped = [];
    lines.forEach((line) => { for (let i = 0; i < line.length; i += 110) wrapped.push(line.slice(i, i + 110)); });
    return wrapped;
}

function draw(cv, t, d, back) {
    cv.text('S58 OVERVIEW / DIAGNOSTICS / MISFIRE DEBUGGER', 24, 64, 22, t.text, { font: 'bold' });
    const preference = d.getSetting('misfireProtocol', 'auto');
    const active = preference === 'auto' ? 'Auto -> ' + (d.mode || 'not detected') : preference;
    cv.text('TASU ' + (d.link.available ? 'available' : 'disconnected') + ' | DME 0x12 | ' + active + ' | ' + (d.monitoring ? 'MONITORING' : 'stopped')
        + (d.busy ? ' / reading...' : '') + ' | last parsed reply ' + (d.lastSuccess || '--'), 24, 94, 18, t.dim);
    const button = (x, w, label, act, disabled) => G.button(cv, t, x, 465, w, 40, label, () => {
        try { return Promise.resolve(act()).catch((e) => { d.message = String(e.message || e); }); }
        catch (e) { d.message = String(e.message || e); return null; }
    }, { busy: !!disabled, key: 'mf-' + label });
    const parked = d.stationary();
    if (d.inspector) {
        if (!parked) {
            cv.text('Raw inspection is for stationary use. Park with a valid speed signal.', 36, 180, 26, t.warn);
            cv.text('Monitoring may continue; use the dashboard for capture status.', 36, 220, 22, t.dim);
        } else {
            const lines = inspectorLines(d), pages = Math.max(1, Math.ceil(lines.length / 9));
            d.page = (d.page + pages) % pages;
            lines.slice(d.page * 9, d.page * 9 + 9).forEach((line, i) => cv.text(line, 28, 130 + i * 31, 19, t.text));
            cv.text('MID ' + hex(d.selectedMid) + ' | page ' + (d.page + 1) + '/' + pages + ' | all returned tests shown; no TID substitution', 28, 424, 18, t.warn);
        }
        button(24, 214, 'Read selected MID', () => d.refresh(d.selectedMid), !parked || d.busy);
        button(250, 186, 'Next MID', () => d.action('nextmid'), !parked);
        button(448, 186, 'Next TID', () => d.action('nexttid'), !parked);
        button(646, 180, 'Previous', () => { d.page--; }, !parked);
        button(838, 180, 'Next', () => { d.page++; }, !parked);
        button(1030, 210, 'Dashboard', () => { d.inspector = false; });
        button(1252, 324, 'Back to diagnostics', back);
    } else {
        for (let i = 0; i < 6; i++) {
            const mid = 0xA2 + i, r = d.latest[mid], tid = d.tids[mid] == null ? 12 : d.tids[mid];
            const parsed = r && parse(r.protocol, mid, r.rawResponse, tid), selected = parsed && parsed.selected;
            const x = 24 + (i % 3) * 520, y = 114 + Math.floor(i / 3) * 128;
            cv.fillRect(x, y, 504, 118, '#15171c');
            cv.text('CYLINDER ' + (i + 1) + ' / MID ' + hex(mid) + (r ? ' / ' + r.protocol : ''), x + 14, y + 24, 20, t.text, { font: 'bold' });
            cv.text('Raw ' + (selected ? selected.rawValue : '--') + ' | scaled ' + (selected && selected.scaledValue != null ? selected.scaledValue + ' ' + selected.unit : '--'), x + 14, y + 51, 24, t.text);
            cv.text('TID ' + hex(tid) + ' | UASID ' + (selected ? hex(selected.uasid) : '--') + ' | raw delta ' + (r && r.rawDelta != null && r.selectedTid === tid ? '+' + r.rawDelta : '--'), x + 14, y + 76, 18, t.dim);
            const state = !r ? 'NOT READ' : r.status !== 'parsed' ? r.status : parsed.status !== 'parsed' ? parsed.status : selected ? selected.status : 'no selected test';
            cv.text(state + (r && r.change.indexOf('decrease') === 0 ? ' / possible reset' : ''), x + 14, y + 101, 17, t.warn);
            if (cv.own && parked) cv.target(x, y, 504, 118, () => { d.selectedMid = mid; d.inspector = true; d.page = 0; }, 'mf-cylinder-' + (i + 1));
        }
        const sum = d.summary();
        cv.text('Raw monitor sum: ' + (sum.rawSum == null ? '-- (need six compatible values from one scan)' : sum.rawSum)
            + ' | Interpretation: UNVERIFIED | Confirmed misfire count: --', 24, 394, 22, t.warn);
        cv.text('Timeout ' + d.timeout() + ' ms | interval ' + d.interval() / 1000 + ' s after scan | captures ' + d.records.length
            + ' | snapshot values are not simultaneous', 24, 423, 18, t.dim);
        button(24, 228, 'Refresh / Retry', () => d.refresh(), !parked || d.busy);
        button(264, 228, d.monitoring ? 'Stop monitoring' : 'Start monitoring', () => d.monitoring ? d.stop() : d.start(), !d.monitoring && !parked);
        button(504, 268, 'Reset local baseline', () => d.resetBaseline(), !parked);
        button(784, 250, 'Export JSON / CSV', () => d.export(), !parked || d.exporting);
        button(1046, 220, 'Inspector', () => { d.inspector = true; d.page = 0; }, !parked);
        button(1278, 298, 'Back to diagnostics', back);
    }
    cv.text(String(d.message).slice(0, 155), 24, 450, 17, t.dim);
}

module.exports = { parse, scale, classify, Debugger, draw, inspectorLines, MIDS, SOURCE };
