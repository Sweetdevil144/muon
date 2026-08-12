/**
 * The EMBEDDED brain's stable loopback port.
 *
 * ONE NUMBER, shared by the backend that binds it and every client that would
 * otherwise have to discover it.
 *
 * CHOSEN BELOW 32768, which is the bottom of Linux's ephemeral range
 * (32768–60999; macOS uses 49152–65535). A "stable" port inside either range
 * is one the kernel may hand to an unrelated process first, which would make
 * the collision a design feature rather than an accident — the first candidate
 * here, 47100, was fine on macOS and wrong on Linux, and its own test caught
 * it. Also clear of the dev ports a user is likely to be running already
 * (3000, 3050, 4000, 5173, 8000, 8080).
 *
 * 10566 for the muon's mass, 105.66 MeV — a number nobody else picks.
 *
 * A brain that cannot bind it falls back to an ephemeral port and publishes
 * THAT in the lockfile, so discovery keeps working: this constant is the
 * PREFERENCE, never an assumption a caller may hard-code. Read the lockfile.
 */
export const DEFAULT_EMBEDDED_BRAIN_PORT = 10_566;
