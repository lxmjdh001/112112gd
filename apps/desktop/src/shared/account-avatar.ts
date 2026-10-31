// Only small raster PNG snapshots can cross from an embedded page into the shell.
export function validAccountAvatar(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 24000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return false;
  const bytes = Buffer.from(value.slice(22), "base64");
  return (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(16) <= 128 &&
    bytes.readUInt32BE(20) > 0 &&
    bytes.readUInt32BE(20) <= 128
  );
}
