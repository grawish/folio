// A pack may supply flat TeX resources, never native executables or paths.
export function resourceName(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}\.(?:sty|cls|clo|tex|ltx|cfg|def|fd|map|enc|tfm|vf|pfb|pfm|afm|otf|ttf|bib|bst|bbx|cbx|lbx|dbx|bbl|pdf|png|jpg|eps)$/.test(
      value,
    )
  )
    throw new Error('The resource pack contains an unsupported resource filename.');
  return value;
}
