const { requireEnv } = require('../require-env');

describe('requireEnv', () => {
  const originalEnv = { ...process.env };
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  test('returns silently when all keys are set', () => {
    process.env.RE_TEST_A = 'a';
    process.env.RE_TEST_B = 'b';
    expect(() => requireEnv(['RE_TEST_A', 'RE_TEST_B'])).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test('throws and logs every missing key when any are missing', () => {
    process.env.RE_TEST_A = 'a';
    delete process.env.RE_TEST_B;
    delete process.env.RE_TEST_C;
    expect(() => requireEnv(['RE_TEST_A', 'RE_TEST_B', 'RE_TEST_C'])).toThrow(
      /Missing required env vars: RE_TEST_B, RE_TEST_C/
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('[boot] missing required env var: RE_TEST_B');
    expect(consoleErrorSpy).toHaveBeenCalledWith('[boot] missing required env var: RE_TEST_C');
  });

  test('treats empty string as missing (Render env var "set to empty" footgun)', () => {
    process.env.RE_TEST_A = '';
    expect(() => requireEnv(['RE_TEST_A'])).toThrow(/RE_TEST_A/);
  });

  test('treats whitespace-only as missing (paste-with-newline footgun)', () => {
    process.env.RE_TEST_A = '   ';
    expect(() => requireEnv(['RE_TEST_A'])).toThrow(/RE_TEST_A/);
    process.env.RE_TEST_B = '\n';
    expect(() => requireEnv(['RE_TEST_B'])).toThrow(/RE_TEST_B/);
  });

  test('empty key list is a no-op', () => {
    expect(() => requireEnv([])).not.toThrow();
  });
});
