"""Fail closed when a PlatformIO upload target is requested."""

Import("env")  # type: ignore[name-defined]  # Provided by PlatformIO/SCons.


def refuse_upload(source, target, environment):
    del source, target, environment
    raise RuntimeError(
        "Refusing PlatformIO upload: verify firmware.bin and use "
        "scripts/flash-app-only.ps1 to write only app0 at 0x10000."
    )


env.AddPreAction("upload", refuse_upload)  # type: ignore[name-defined]

