// A spawned Pi must resolve its own package directory.
// A parent Pi session exports PI_PACKAGE_DIR for another version, so tests drop it.
export const hostEnvironment: NodeJS.ProcessEnv = { ...process.env, PI_PACKAGE_DIR: undefined };
