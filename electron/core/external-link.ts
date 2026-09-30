const maxExternalLinkLength = 2048;
const allowedProtocols: Record<string, true> = { 'https:': true, 'http:': true, 'mailto:': true };

export function externalLink(value: unknown) {
  if (typeof value !== 'string' || value.length > maxExternalLinkLength)
    throw new Error('Invalid link.');
  const url = new URL(value);
  if (!allowedProtocols[url.protocol] || url.username || url.password)
    throw new Error('This link type is not supported.');
  return url;
}
