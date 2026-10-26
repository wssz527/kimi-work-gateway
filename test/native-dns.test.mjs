import { test, expect } from 'bun:test';
import dgram from 'node:dgram';
import { BYOK_ADDRESS, BYOK_DOMAIN, NativeByokDNS, dnsReply, nativePrivateAddress } from '../src/index.mjs';

function query(domain, type = 1) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(317, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels = domain.split('.').flatMap(label => [Buffer.from([label.length]), Buffer.from(label)]);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}

test('the listener answers only the BYOK name and never becomes a general resolver', async () => {
  const server = new NativeByokDNS();
  await server.start(0);
  const client = dgram.createSocket('udp4');
  try {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('local DNS timeout')), 1000);
      client.once('message', packet => { clearTimeout(timer); resolve(packet); });
      client.send(query(BYOK_DOMAIN), server.address.port, '127.0.0.1');
    });
    expect([...response.subarray(-4)].join('.')).toBe(BYOK_ADDRESS);
    expect(response.readUInt16BE(6)).toBe(1);
    const refused = dnsReply(query('www.kimi.com'));
    expect(refused.readUInt16BE(2) & 15).toBe(5);
    expect(refused.readUInt16BE(6)).toBe(0);
  } finally {
    client.close();
    await server.stop();
  }
});

test('malformed and out-of-scope packets are dropped or refused, never forwarded', () => {
  expect(dnsReply(Buffer.alloc(4))).toBeNull();
  expect(dnsReply(query(BYOK_DOMAIN, 28)).readUInt16BE(6)).toBe(0);
  expect(dnsReply(query(BYOK_DOMAIN, 15)).readUInt16BE(2) & 15).toBe(5);
  // An EDNS OPT record follows the question; it must not stop the answer.
  const edns = Buffer.concat([query(BYOK_DOMAIN), Buffer.from([0, 0, 41, 16, 0, 0, 0, 0, 0, 0, 0])]);
  expect(dnsReply(edns).readUInt16BE(6)).toBe(1);
  const answered = Buffer.from(query(BYOK_DOMAIN));
  answered.writeUInt16BE(0x8100, 2);
  expect(dnsReply(answered)).toBeNull();
  const truncated = query(BYOK_DOMAIN).subarray(0, 20);
  expect(dnsReply(truncated)).toBeNull();
  const labelOverflow = Buffer.concat([query(BYOK_DOMAIN).subarray(0, 12), Buffer.from([63]),
    Buffer.alloc(10, 0x61)]);
  expect(dnsReply(labelOverflow)).toBeNull();
});

test('private address detection covers loopback-free internal ranges only', () => {
  expect(nativePrivateAddress('10.255.255.254')).toBe(true);
  expect(nativePrivateAddress('172.16.0.1')).toBe(true);
  expect(nativePrivateAddress('172.31.255.1')).toBe(true);
  expect(nativePrivateAddress(['172', '32', '0', '1'].join('.'))).toBe(false);
  expect(nativePrivateAddress('192.168.1.1')).toBe(true);
  expect(nativePrivateAddress('127.0.0.1')).toBe(false);
  expect(nativePrivateAddress('8.8.8.8')).toBe(false);
  expect(nativePrivateAddress('fd00::1')).toBe(true);
  expect(nativePrivateAddress('2001:db8::1')).toBe(false);
  expect(nativePrivateAddress('not-an-ip')).toBe(false);
});
