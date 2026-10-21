# MoonE-ink firmware

This is the formal firmware project for the verified logical board profile
`lilygo-t5-47-s3-pro-lite-h752-01`, profile revision 1.

The checked-in PlatformIO board definition fixes the verified Pro Lite memory
type, capacity, 5 MiB app ceiling and factory-compatible partition CSV. It does
not configure a debugger, so ordinary builds do not download an unrelated
OpenOCD toolchain. Runtime hardware behavior comes from the versioned
BoardProfile and backend.

The current firmware provides a bounded EventBus, fixed AppManager registry,
single-owner DisplayManager, read-only partition inspection, portrait/landscape
touch transforms and an M5GFX display backend. M2 r4 adds immutable frame
identity, desired/cached/presented state, modal overlay takeover and restore,
generation-bound hitboxes, refresh-time input blocking and a bounded display
failure latch. M3 adds an LVGL 8.4.0 port and a pure-white 540×960 local
Settings/Diagnostics page. M4 adds the vertical-profile Device Channel client,
browser USB provisioning, authenticated frame download, hash verification,
PSRAM-backed cache and cached/presented receipts. The current product path stages
Wi-Fi and a stable pair request in NVS, atomically commits the returned binding,
and restores it after restart.

The A1 Shell revision replaces the ID-only AppManager with an eight-slot App
interface: enter/exit/render, foreground input, targeted background events,
wake/sleep hooks, bounded versioned state and activation-generation tokens for
rejecting late foreground results. Diagnostics, Settings and Ephemera all use
that lifecycle. Shell-owned Home input now precedes App readiness; BOOT/S3 page
semantics route only to the active App. A modal LVGL Launcher preserves and
restores any active App, exposes Settings/Diagnostics/Reader while unpaired, and
exposes Ephemera only after its persistent binding is ready. Reader remains launchable
without a card and shows a bounded local insert-card state instead of blocking
the Shell. Its optional Ephemera controls retain the M5 reading actions. The
system page and warm light remain usable when Ephemera is offline or its event
outbox applies backpressure.

The D1 Reader software foundation adds a native App and a network-independent,
bounded raw-TXT core. The parser reads through a 256-byte window, strictly
accepts UTF-8 with an optional BOM, normalizes LF/CRLF only in the display view,
preserves raw source-byte offsets, explicit blank lines and a final unterminated
line, and wraps long lines locally. Invalid UTF-8, UTF-16 BOMs, read failure,
cancellation and page-buffer exhaustion are separate fail-closed results. A
bounded 128-entry recent page index is disposable and bound to both a streamed
content identity and layout/font revisions; books can continue beyond 16 pages.
The independent Reader progress record is versioned, checksummed and atomically
replaceable, so a torn record falls back to the book start and a same-name,
same-size replacement does not inherit progress by path alone. The App advances
its visible source offset only after display presentation and input binding
succeed.

This is not yet a completed physical Reader: the H752-01 TF adapter/library scan,
background identity/index scheduling, encrypted-flash progress backend and the
licensed 26 px offline Chinese font package are not connected. Until those are
present, the runtime Reader entry intentionally remains on its insertion/status
screen; built-in Montserrat is not claimed as Chinese book coverage. No TF card
is currently available, so every card-dependent acceptance case is recorded as
pending verification rather than passed or failed.

The E1/M6 package-policy foundation is also host tested. It accepts only schema-1
`lvgl-layout` candidates: no native binary, script runtime, or SD-supplied
`remote-framebuffer` adapter. It rejects reserved built-in ids, incompatible
strict semantic versions, unknown/duplicate permissions, absolute/backslash/
drive/empty/`.`/`..` entry paths and every over-budget resource fact. The frozen
starting envelope is 4 KiB manifest, 64 KiB layout, 64 files, 32 assets, 1 MiB
per asset, 4 MiB assets total, one 540×960 decoded image, 128 UI nodes, depth 12
and 512-byte strings. A nonzero full-snapshot SHA-256 and explicit grant set are
required; first install and every content/version/permission change require a
confirmation plan. Reusing the private namespace is a separate explicit upgrade
choice, while isolation requires a genuinely new local install identity. The
follow-on snapshot layer canonicalizes at most 64 normalized files, streams them
through 256-byte windows into a sealed staging store, and hashes path, length and
content with SHA-256. Enumeration order cannot change the digest; a changed seal
identity or any byte change between approval and commit fails closed.
`manifest.json` is parsed from that seal through a 128-byte window with required,
duplicate and unknown-field checks plus bounded Unicode, runtime and permission
handling. Candidate facts and the entry file are derived from those same sealed
bytes. A four-slot versioned, checksummed registry persists install identity,
approved digest and grants atomically.

This is not yet an installer: the H752-01 filesystem/image-decoder and atomic
staging adapters, strict declarative layout inspector, approval UI, sealed-byte
promotion, LVGL runtime, fault quarantine and private namespace cleanup are not
connected. The registry has no reviewed encrypted-flash backend in the current
factory layout. No third-party App is registered by this revision.

The E1/M8 OTA policy foundation is host tested as well. A staged candidate must
target the exact board profile, profile revision, partition layout and inactive
slot; fit that slot; carry a nonzero digest with trusted-signature and verified-
image evidence; and remain compatible with both the current journal schema and
the last confirmed readable configuration schema. Exactly one trial boot is
allowed. Display, input, storage, configuration and journal checks are local
confirmation gates, while service reachability is diagnostic only. A reset or
failed local gate before confirmation requests rollback, and deep sleep is
blocked throughout staging/trial/rollback. The monotonic continuity watermark is
never reduced by trial or rollback.

This is not yet a device OTA implementation: no ESP partition write, bootloader
slot switch, signature verifier, persistent OTA metadata journal, rollback image
or USB recovery path is wired by this revision.

M5 now includes bounded `history`/`pages` response models, validated Device
Channel HTTP methods, a current-frame-bound navigation state machine, explicit
Shell actions, and an eight-entry immutable event outbox. The runtime executes
same-publication paging, snapshot history navigation, `return_latest` and
`acknowledge`; each presentation follows interaction → verified download →
cached → physical refresh → presented. M4 receipts use the same FIFO, so a failed
post cannot be overwritten by the next receipt and retry preserves the original
event id, sequence and payload. The FIFO now has an M7 persistence mode: it
commits the next sequence and complete pending set before exposing a new event,
restores both after restart, fails closed after a journal write error, and resets
scope on a replacement binding. The current factory-compatible image now supplies
an NVS-backed implementation for the device binding and event journal. NVS blob
replacement is power-loss-safe; each application envelope also carries a monotonic
generation and SHA-256 checksum. NVS encryption is not claimed until a later
manufacturing/eFuse policy is approved.

The B1 storage foundation also includes a host-tested provisioning recovery record.
The device atomically stages Wi-Fi, the endpoint, enrollment code and stable pairing
request ID when the browser sends the USB setup command. After a successful response
it atomically installs the binding and erases the one-time enrollment code. Restart
before that commit resumes the same pairing ID, while reset writes a newer empty
generation so old local credentials are not selected. Public HTTPS uses the firmware's
system CA bundle with hostname/date verification; plain HTTP is limited to private or
local hosts. The browser supplies a bounded initial Unix time and cold restart performs
bounded NTP sync before HTTPS. Automated build/host verification is complete; the final
full-erase → configure → unplug → power-cycle recovery remains pending one concentrated
real-board acceptance run.

The Home long-press system page now exposes six 215×132 px local controls for
previous/next page, older/newer publication, return latest and acknowledge.
Those controls are Shell-owned and work even when a publication advertises no
remote action hitboxes. A selected action is validated against the frame that
opened the system page; the last-good page is restored before a network action
so a later failure does not strand the display on a transition surface.

Read acknowledgement follows visible reader intent rather than automatic
delivery. A one-page publication remains unread when it is merely presented and
becomes read on the first key press or touch while that page is visible. A
multi-page publication becomes read only after a forward turn successfully
presents its last page. The system-page acknowledge action remains available as
a manual override; every path emits the same durable publication-level receipt,
so a main issue and its supplement are confirmed together.

The H752-01 input adapter initializes GT911 touch/Home, GPIO0 BOOT and the
PCA9535 S3 input. The accepted control map is:

- GPIO0/BOOT short press: previous page;
- PCA9535 S3 short press: next page;
- PCA9535 S3 long press: toggle the 800 Hz warm-light PWM at the configured
  brightness (currently 50% and RAM-only), without first turning the page;
- front Home short press: return one level; at an App root, open the system home;
- front Home long press: enter/leave the system home directly;
- RST/EN: hard recovery only. It is never consumed as an application action;
- The S3 key is the lower-left exterior key still labelled `IO48`; the
  lower-right power key is the separate BQ25896 QON/S4 hardware path and is
  not reassigned.

Touch input and action hitboxes always remain bound to the physically presented
frame. GT911 touch and all six system-page action regions have passed real-board
execution. The PCA9535 S3 exterior key has passed direct short-press
identification even while unpaired. The revised Home return path and S3
short/long split are compiled and flashed; their visible button behavior remains
the focused real-device acceptance item.

The physical display typography floor is 22 px for readable system text, with
28 px section headings and a 32 px page heading. Smaller glyphs must not carry
state, actions or recovery instructions.

On 2026-10-10 the 550,336-byte M3 app was verified on the target board. It
reported the factory layout and touch transform as passing, initialised the
display at 540×960, completed both the diagnostic and LVGL composed refreshes in
1321 ms each, and entered `RUNNING` with `settings` active and zero dropped
events. The allocator reported 8,386,295 bytes of the nominal 8 MiB PSRAM,
7,089,867 bytes free after display allocation and 6,991,163 bytes free after the
two 540×40 RGB565 LVGL draw buffers. Persistent restart restoration remains a
later Shell reliability item; M3 proves the local LVGL rendering path.

The readable M3 revision was subsequently confirmed clear on the physical
display. M4 first light also passed on 2026-10-10: Wi-Fi association, one-time
pairing, a 259,200-byte gray4 asset download, cached receipt, physical refresh,
presented receipt, Settings takeover and restoration of the cached Ephemera
frame all completed. The Settings/restore sequence was repeated after stopping
the temporary server and still passed, proving that restoration did not require
a second download. Refreshes took about 1.32 seconds. The Arduino loop task is
configured through the framework's `SET_LOOP_TASK_STACK_SIZE` mechanism at 16
KiB for the network/TLS path. That earlier real-board run used the RAM-only predecessor;
the current NVS/Web-Serial replacement is built but has not yet had its final real-board
power-cycle acceptance.

The current A1+B1+D1+E1 software build uses 110,248 bytes of static RAM (33.6% of
327,680) and 1,425,865 bytes of the 5 MiB app partition. The matching bootloader,
partition table and application image are exported with a SHA-256 manifest into the
service's `assets/device-installer/` directory for the Owner console.
Host policy tests cover same-edition
paging, snapshot history navigation, non-preempting pending offers,
`return_latest`, overlay state reporting, current-frame action binding and FIFO
retry/backpressure, plus lifecycle rollback/state restoration, late activation
tokens, global/foreground input routing, storage budget assertions, button
bounce, short-press and one-shot long-press semantics.

On the real board the five-page fixture passed page 1→5 and back navigation;
the one-page older fixture passed previous/next publication; return latest and
acknowledge both returned `receipt=PASS`. The first integrated run exposed a
loop-stack overflow caused by aggregate clearing of the bounded page/history
models. Those clears are now in-place; the same path retains at least 7,772
bytes of loop-task stack headroom. The system-page coordinate harness then
exercised its reading controls on the physical panel. Development serial
commands exist only to make these paths repeatable without faking a remote
action descriptor.

Build with PlatformIO Core 6.2.0:

```powershell
platformio run -e mooneink_t5_pro_lite
```

Run the portable Shell policy tests with a Visual Studio C++ toolchain:

```powershell
.\scripts\test-host.ps1
```

PlatformIO upload remains deliberately disabled so a developer cannot accidentally
push an unreviewed build. The formal first-install path is the Owner console's Web
Serial installer: it verifies the exported manifest, erases the target device, and
writes `bootloader.bin` at `0x0000`, `partitions.bin` at `0x8000` and `firmware.bin`
at `0x10000`. The manifest deliberately uses `keep` for flash mode, frequency and
size: the verified build emits DIO image headers, and a flasher must not rewrite
those headers from the board's QIO-capable hardware metadata. `scripts/flash-app-only.ps1` remains a developer recovery path that
preserves the existing partition table and NVS; do not use `pio run -t upload`.

The durable device-event outbox uses a variable-length schema: an empty queue no
longer stores all eight maximum-size event slots in the board's 20 KiB NVS
partition. Schema 1 records migrate on first boot, temporary NVS buffers prefer
PSRAM, and queue copies live on the heap instead of the Arduino loop-task stack.
Unreadable legacy receipt telemetry is rebuilt without discarding the saved Wi-Fi
or active binding. The real board has passed two consecutive reset recoveries with
Wi-Fi, binding, frame download, display, receipts and interaction manifests all
restored automatically.

After a successful PlatformIO build, refresh the browser-installable artifact set with:

```powershell
node scripts/export-device-installer.mjs `
  --build .pio/build/mooneink_t5_pro_lite `
  --output ../../services/ephemera/assets/device-installer
```

The checked-in partition CSV reproduces the current device's factory layout so
the application can inspect labels and sizes consistently. It is a development
compatibility layout, not the final OTA/publication layout; changing it requires
the separate M0 partition migration and recovery review.

The proposed M7 dual-OTA/font/cache/config/journal budget and migration gates
are documented in [the M7 storage review](../../plan/m7-storage-layout-migration-20261011.md). Its constants
and persistence boundary live in `include/mooneink/persistent_storage.hpp`.
They deliberately do not alter the current factory-preserve partition CSV.

