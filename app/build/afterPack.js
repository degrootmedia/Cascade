// Fuse flipping must run in afterPack (before signing) or the signature is invalidated.
const path = require("node:path");

let fuses;
try {
  fuses = require("@electron/fuses");
} catch {
  fuses = null;
}

exports.default = async function afterPack(ctx) {
  if (!fuses) {
    console.warn("[afterPack] @electron/fuses not installed; skipping fuse flipping.");
    return;
  }
  const { flipFuses, FuseVersion, FuseV1Options } = fuses;
  const app = ctx.packager.appInfo.productFilename;
  // Pick the platform's target WITHOUT building the others first: the Linux
  // entry dereferences ctx.packager.executableName, which is undefined on a
  // Windows build, and an eager object literal would throw on all platforms.
  let target;
  switch (ctx.electronPlatformName) {
    case "darwin":
      target = path.join(ctx.appOutDir, `${app}.app`);
      break;
    case "win32":
      target = path.join(ctx.appOutDir, `${app}.exe`);
      break;
    case "linux":
      target = path.join(ctx.appOutDir, ctx.packager.executableName);
      break;
    default:
      return;
  }

  await flipFuses(target, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: ctx.electronPlatformName === "darwin",
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
  });
};
