/** Inputs shared by the node and exe R1.2 suites: same inputs, same assertions. */
export const BAD_INPUTS: [string, Buffer | string | null][] = [
  ["empty stdin", ""],
  ["closed stdin", null],
  ["not json", "not json"],
  ["array", "[]"],
  ["empty object", "{}"],
  ["null", "null"],
  ["number", "42"],
  ["invalid utf-8 bytes", Buffer.from([0xff, 0xfe, 0x7b, 0x80, 0xc3, 0x28])],
  ["object missing session_id", '{"hook_event_name":"Stop"}'],
  [
    "1 MB json",
    JSON.stringify({ session_id: "s", hook_event_name: "Stop", big: "x".repeat(1 << 20) }),
  ],
  ["4 MB binary", Buffer.alloc(4 << 20, 0xab)],
];
