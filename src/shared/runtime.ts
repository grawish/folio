export type RuntimePin = {
  engine: 'tectonic';
  version: string;
  bundle: string;
  // Older project manifests record labels only. They are resolved once against
  // matching bundled labels; a complete pin includes the manifest digest and OS.
  id?: string;
  platform?: string;
  biberVersion?: string;
};

export function validateRuntimePin(value: unknown): RuntimePin | undefined {
  if (value === undefined) return undefined;
  const pin = value as RuntimePin;
  if (
    !pin ||
    pin.engine !== 'tectonic' ||
    typeof pin.version !== 'string' ||
    !/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(pin.version) ||
    typeof pin.bundle !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(pin.bundle) ||
    (pin.biberVersion !== undefined &&
      (typeof pin.biberVersion !== 'string' ||
        !/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(pin.biberVersion))) ||
    (pin.id !== undefined && (typeof pin.id !== 'string' || !/^[a-f0-9]{64}$/.test(pin.id))) ||
    (pin.id !== undefined &&
      (typeof pin.platform !== 'string' ||
        !/^(darwin|linux|win32)-(arm64|x64)$/.test(pin.platform))) ||
    (pin.id === undefined && pin.platform !== undefined)
  )
    throw new Error('The project compiler selection is invalid.');
  return {
    engine: 'tectonic',
    version: pin.version,
    bundle: pin.bundle,
    ...(pin.id ? { id: pin.id, platform: pin.platform } : {}),
    ...(pin.biberVersion ? { biberVersion: pin.biberVersion } : {}),
  };
}

export function projectRuntime(metadata: {
  runtime?: unknown;
  engine?: unknown;
  bundle?: unknown;
}) {
  if (metadata.runtime !== undefined) return validateRuntimePin(metadata.runtime);
  if (metadata.engine === undefined && metadata.bundle === undefined) return undefined;
  if (typeof metadata.engine !== 'string' || !metadata.engine.startsWith('tectonic@'))
    throw new Error(
      'This project records an unsupported compiler. Its files have not been changed.',
    );
  return validateRuntimePin({
    engine: 'tectonic',
    version: metadata.engine.slice(9),
    bundle: metadata.bundle,
  });
}

export function adoptRuntime(pin: RuntimePin | undefined, bundled: RuntimePin | undefined) {
  if (!pin) return bundled;
  if (
    !pin.id &&
    bundled &&
    pin.version === bundled.version &&
    pin.bundle === bundled.bundle &&
    (!pin.biberVersion || pin.biberVersion === bundled.biberVersion)
  )
    return bundled;
  return pin;
}
