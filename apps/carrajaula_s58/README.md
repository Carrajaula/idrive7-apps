# S58 Overview

Read-only dashboard for the 2021 G80 M3 S58, styled after the supplied bTres reference.
Boost, low-side and rail fuel pressures are in bar; WGDC is in percent.
AFR is decoded lambda multiplied by 14.7 (gasoline-equivalent display scale,
including when the actual fuel contains ethanol). No bank averaging is performed.

## Sources and limits

The `app.json` source candidates reuse M Vitals and Live Data mappings. The native
DIDs come from Live Data's DME8FF_R catalog: they remain candidates until verified
on the S58. ReadOnlyDiag permits reads only and serializes/paces requests.
No map switching, actuator commands, memory writes, or ECU changes are made.

- Boost: absolute charge pressure minus a measured ambient pressure. No fixed
  ambient-pressure fallback. Target uses the same measured ambient pressure.
- WGDC: DID 4AAB, actuator duty cycle. It is not EWG position in mm or percent.
- AFR: DIDs 5889 / 5640, then OBD 34 (bank 1 sensor 1). These are candidates for
  one lambda reading, not proof of two bank measurements.
- LPFP: DIDs 58F3 / 5463, from the existing low-pressure sensor mappings. The
  manifold-relative OBD rail-pressure candidate is deliberately not used as LPFP.
- RAIL ACTUAL: DIDs 58EF / 5658, then M Vitals' standard rail-pressure candidates.
  This is one generic reported rail pressure, not a verified identification of
  pump 1. It does not measure pump duty, flow or mechanical health.
- KNK AVG: DID 554C, the existing Live Data ECU-computed mean of cylinder-specific
  ignition retard due to knock control. Signed byte * 0.375 degrees, displayed
  as a positive retard magnitude. This replaces RAIL TARGET; no requested rail
  pressure is polled. It is not a misfire count, absolute ignition angle,
  knock-sensor voltage, or a locally computed mean of six live MHD channels.
  Those six channels do not yet have verified mappings here. The DME8FF_R
  candidate still needs validation on the S58, as do the other native candidates.
  Source: [diagnostic catalog](https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/dme8ff_r/).
- IAT / charge air: DIDs 580F / 59D4; IAT also has M Vitals' existing candidates.
- Oil / coolant: the existing Car SOME/IP temperature reader.
- Gearbox: M Vitals' EGS 6000 / DA12 candidates, ECU 0x18.
- Ethanol Active: the exact MHD request `2C 88 01`, to physical DME 0x12 only.
  The reply must be `6C 88` plus exactly 36 data bytes. Body offset 0x0F
  (full reply index 0x11) is an unsigned percentage, accepted only in 0..100.
  Invalid replies, refusals and timeouts remain unavailable. No generic or CAN
  ethanol substitution. The transport permits no other 2C command or target.
  Source: [MHD Tuning MG1.adx](https://github.com/dmacpro91/BMW-XDFs/blob/master/Real%20time%20tuning/MG1.adx).
  Format is documented; support on this ROM through TASU still needs a car test.

Failed reads immediately become unavailable; diagnostic samples expire after
10 seconds. An unsupported reading is retried after 30 seconds. Polling pauses
when the screen is hidden or demo mode is selected. Peaks reset between demo and
live modes and never reset anything in the ECU. Ring scales are display ranges,
not tuning limits or diagnostic alarm thresholds.

## Local use

```sh
python3 kit/tools/build.py carrajaula_s58 --preview-only
node kit/tools/emu.js carrajaula_s58
node kit/tools/test_s58_overview.js
```

Open http://localhost:8077 and set Demo data to Always for illustrative moving
gauges, including the arithmetic mean of six simulated retard magnitudes
and Active ethanol of 17%. The default is Never; absent ECU readings stay `--`. No private log, VIN or ECU binary is bundled.

A flash binary can help identify ROM-specific definitions when matching symbols
or logging definitions exist. By itself it does not establish runtime RAM
addresses or whether the documented MHD monitor is reachable through TASU.

## Screenshot diagnostics

Inside S58 Overview choose **Diagnostics / Overview**, then **Previous diagnostics**
or **Next diagnostics**. Three source candidates fit on each page. Each shows its
ECU address, exact UDS request, complete raw reply, age and result (OK, NOT READ,
no reply, NRC, malformed reply, out of range, or STALE). All fallback candidates
are listed; NOT READ does not mean unsupported. Boost absolute/ambient/target and
lambda (AFR = lambda * 14.7) are separate entries. Oil/coolant show received raw
CDS temperature fields instead of inventing a UDS request; their age is time since
the last signal change. Navigation does not issue additional diagnostic requests.
Demo pauses requests and hides live replies. Send screenshots of relevant pages,
including the page number, TX, RX and result. The screen has no VIN or ECU binary.

After five unanswered requests the shared link pauses that ECU. S58 Overview
wakes a paused ECU for another attempt after 30 seconds, independently of other
units, while visible and outside demo mode. It sends no session, security-access
or tester-present commands. Diagnostics distinguishes `not sent: ECU paused`
from a transmitted request that timed out, and shows request/timeout/busy counters
and the retry countdown. This fixes an indefinite local pause, not an ECU or
gateway restriction while driving. If the initial interruption persists, transport
logs are still needed to distinguish its cause.

## Polling and transport diagnostics (0.1.5)

Working readings refresh before one fallback candidate per round, rather than
waiting behind a sweep of unsupported identifiers. A candidate that works stays
selected; failed candidates rotate and back off after a complete failed cycle.
Native UDS, OBD and MHD reads wait 1500 ms, matching Live Data's normal read window
(the previous S58 window was 1200 ms). Response-pending handling is unchanged.

For short replies and timeouts, the spare diagnostic line shows elapsed ms, the
TASU method verdict, pending-response count, observed TASU errors/rejects, or the
last unmatched UDS reply. The same observations accompany timed-out reads in the
app log. `NO_ERROR` means the TASU method accepted the request, not that the ECU
answered. Events are broadcast to every client: `observed` is deliberately not
attributed to this request, and never causes a matching ECU reply to be discarded.
Session changes, tester-present and security access remain blocked. Neither this
poller nor the shared transport contains a speed-triggered diagnostic cutoff.

Synthetic checks reproduce fallback starvation and hidden transport observations;
they do not establish why an S58 ECU/gateway stops responding when moving. Compare
one diagnostic app at a time and capture a failing page with its transport details
before concluding that an ECU, gateway, request timing or mapping caused it.

For a controlled comparison with M Vitals / Live Data, turn **MHD ethanol monitor**
off in Settings. The default remains on. Off sends no `2C 88 01` request, clears
the live ethanol reading and labels its diagnostic row `disabled in Settings`;
standard UDS/OBD readings continue. This isolates a request the other dashboards
do not send, without claiming that the custom monitor caused a dropout.

## Misfire Debugger (0.2.0)

Open **Diagnostics -> Misfire Debugger**, or its top tab. Capture is off by default.
It reuses the existing read-only link and request queue; it creates no second DME
connection and never changes an ECU diagnostic session. Normal gauges refresh
between individual debugger requests. Mode 06 has an exact allowlist: physical
DME 0x12, only A0 and A2..A7. Other non-reading commands remain blocked.

### Capture and inspect

1. Park, select **Demo data -> Never**, and wait for a valid zero-speed signal.
   Manual requests, raw inspection, baseline reset and export require a stationary
   vehicle. No misfire responses are synthesized in demo mode.
2. In Settings choose **Misfire request mode**: Auto, Mode 06 or UDS F6. Auto first
   probes `06 A2`, then `22 F6 A2` if needed. A missing TID does not make Auto
   pretend the protocol is unsupported: parsing and meaning are separate.
3. **Refresh / Retry** captures A0 and each cylinder A2..A7. **Start monitoring**
   repeats these scans; **Stop monitoring** cancels queued work. An already-sent
   request can finish within its deadline; its late response is retained as
   cancelled and cannot update the live tiles. Leaving the app stops monitoring.
4. The reply timeout is configurable (1..10 s, default 4), including a hard cap
   for response-pending waits. Scans wait a configurable 5..120 s after completion
   (default 10 s). Only one debugger request is in flight. Regular telemetry and
   the debugger are serialized by the same queue.
5. Open **Inspector**, or select a cylinder tile. **Next MID** includes A0 and all
   six cylinder identifiers. **Read selected MID** explicitly retries that MID.
   **Next TID** selects among tests actually returned; it never silently replaces
   the default 0C. Previous/Next paginate the entire response and all test records.
   Settings' manual protocol selection lets both formats be inspected separately.

Every request records UTC request/reply timestamps, timeout, duration, target,
protocol, full raw bytes, all decoded test fields, NRC/error, transport observations
and a telemetry snapshot at reply receipt. Incorrect MIDs, duplicate/missing TIDs,
incomplete records, trailing bytes and unknown unit identifiers stay visible.
A timeout is not classified as an unsupported monitor without an explicit NRC.
Shared TASU observations are not attributed to this request as ECU negative replies.

### Units and interpretation evidence

Checked source: [SAE J1979-DA OCT2011](https://www.e90post.com/forums/attachment.php?attachmentid=1509324&d=1476497126),
tables C2, D1 and E1-E4/E36 (printed pages 104, 106, 109 and 116).
A2..A7 identify cylinders 1..6. TID 0C describes calculated, rounded results for
last/current driving cycles; 0B describes a previous-cycle EWMA. Both specify
UASID 24: unsigned counts at one count per bit. UASID 01 is a raw number, not a
misfire-count unit. The decoder also supports the documented raw-value scales
02/03/04; other UASIDs remain unknown rather than receiving an invented scale.
These are historical standard definitions, not proof of the S58 ROM's behavior.
No standard PDF or BMW diagnostic definition is bundled.

The UDS F6 parser implements M Vitals' candidate eight-byte-record layout, explicitly
unverified on this S58. Mode 06 uses nine-byte records including MID. Successful
parsing never sets `interpretationVerified` true. There are no real S58 Mode 06/F6
captures in the repository and no confirmed misfire count is displayed. Scaling
and raw values are separate; unknown UASIDs have no scaled value. The full unsigned
16-bit range is retained, including FFFF; no undocumented sentinel is assumed.

M Vitals selects 0C or silently the first test, reads unscaled 16-bit values and
subtracts its local reset baseline; it does not independently count combustion
events. It discards that baseline after a decrease. This debugger instead records
the decrease as a possible reset, cycle transition or change in semantics, exposes
all tests, and does not turn a decrease into a negative misfire delta.

A **Raw monitor sum** is shown only for six compatible selected tests from one
scan, with matching mode, TID and UASID. Samples are sequential, not simultaneous.
It is never labeled Total misfires. Local baseline resets issue no DME requests;
raw deltas require comparable samples and are not asserted to be cumulative event
counts. A decrease invalidates the baseline until it is explicitly reset again.

### Telemetry and conditions

RPM, speed and gear use the existing Car/SOME-IP readers. Speed/gear subscriptions
add no DME diagnostic requests. An estimated gear is flagged `gearEstimated`.
Boost, IAT, coolant and active ethanol reuse existing S58 readings. Pedal, throttle
and engine-load fields stay null because this app has no verified sources for them.
Snapshots are taken at reply receipt; they are not ECU-synchronized measurements.
Condition labels are conservative heuristics, not diagnosis: idle requires a valid
near-zero speed and 400..1200 rpm; acceleration/deceleration use successive speed
changes beyond +/-2 km/h/s; steady cruising requires >10 km/h and <0.5 km/h/s.
Unknown/stale timing (>30 s), missing speed/RPM, and other cases remain unknown.
High load requires an actual load reading >=80%; unavailable load is not guessed.

### Export and retention

**Export JSON / CSV** writes both files into the app's existing data directory:
`misfire-export-<UTC timestamp>.json` and `.csv`. JSON includes every request, all
tests, original raw responses, local-baseline events and transport observations.
CSV has one row per returned test (or one row for a failed request), with raw
responses, values/limits, status, protocol and serialized snapshots/transport data.
The inspector shows the full output paths after export; use the head unit's normal
file-transfer access to retrieve them. This exports files locally, not to a cloud
service or directly to a USB stick.

Full request records also stream asynchronously to `misfire-<session UTC>.jsonl`
in the same data directory, independently of the existing rotating app log.
At 5000 captured requests monitoring stops instead of discarding evidence. Export
and restart the app for a fresh capture. Export/file-write failures are shown on
screen; captured records remain in memory. Do not rely on a rotating app log as
the only copy of a long drive's raw data.

### S58 validation still required

The reported values 5/8/13/9/9/5 are an observation from M Vitals, not a raw capture.
No conclusion that their sum 49 represents 49 physical misfire events is justified
without the exact returned MID/TID/UASID, frame layout and cycle behavior. Capture
the initial A2 probe, the A0 bitmap and A2..A7 in both supported modes, then compare
selected 0C records and a controlled local baseline across operating conditions.
Use one active diagnostic client for this comparison. A missing fault code or a
clean ignition-retard log does not validate or invalidate this parser's result.

Synthetic checks (not BMW capture fixtures):

```sh
node kit/tools/test_s58_misfire.js
node kit/tools/test_s58_overview.js
node kit/tools/test_live_data.js
```

Without touch routing / with the software renderer, the same actions are available
through **Settings -> Misfire action**, then **Run misfire action** in the native
button bar. This includes start/stop, refresh, baseline, export, inspector, MID/TID
selection and inspector pagination; it uses the same stationary checks and queue.

Each fresh debugger scan clears the link's local DME-pause flag once, as Live
Data's Read all does. This lets a known monitor be retried after unrelated
telemetry misses; it sends no wakeup/session/reset command to the ECU. Requests
remain serialized, bounded by the selected deadline, and separated by the scan
interval. A scan that again loses replies still hits the normal five-miss pause.
