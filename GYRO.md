# Gyro tuning

G7 Pro 8K gyro controls use the existing profile read/write path. Edits are staged and applied with Write to controller. Other models stay locked until their motion layout is verified.

Aim and Tilt keep separate settings and mutually exclusive activation. Controls include activation combinations, shared sensor preset, output mapping, yaw/roll orientation, inversion, axis balance, sensitivity, directional outputs, input/output ranges, and a five-point response curve.

The 41-byte layout recovered from Connect uses activation at 0, keys at 1-3, orientation at 4, range enable at 5, ranges at 6-13, curve at 14-26, mapping enable at 27, inversion at 28-30, axis balance at 31, mouse sensitivity at 32, output at 33, directional keys at 35-39 and stick sensitivity at 40. Byte 34 stays untouched. The old accessors overlapped orientation/keys and the deadzone flag; this fixes those offsets.

Tests cover offsets, activation exclusivity, atomic validation, and preservation of unrelated bytes. These are codec tests, not proof of physical behavior on every firmware. Mouse support depends on mode and firmware; sensor names are not measured polling-rate claims.
