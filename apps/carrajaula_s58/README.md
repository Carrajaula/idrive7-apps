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
