import { describe, expect, test } from 'bun:test';
import { parseEnvFile } from './index.ts';

describe('parseEnvFile', () => {
  test('reads a plain assignment', () => {
    expect(parseEnvFile('A=1')).toEqual({ A: '1' });
  });

  test('strips a trailing comment from an unquoted value', () => {
    expect(parseEnvFile('A=hello   # a note')).toEqual({ A: 'hello' });
  });

  test('strips quotes even when a comment follows', () => {
    // The bug this exists for: the old parser only unquoted a value when the
    // LINE ended with the quote, so a trailing comment left the quotes attached
    // and they travelled into URLs and headers as literal characters.
    expect(parseEnvFile('A="secret-value"   # from @BotFather')).toEqual({ A: 'secret-value' });
    expect(parseEnvFile("A='secret-value'   # note")).toEqual({ A: 'secret-value' });
  });

  test('tolerates whitespace around the equals sign', () => {
    expect(parseEnvFile('A = "v"')).toEqual({ A: 'v' });
  });

  test('keeps a # that is part of a quoted value', () => {
    // Passwords and tokens contain # often enough that stripping from the first
    // one corrupts them.
    expect(parseEnvFile('A="pa#ss word"')).toEqual({ A: 'pa#ss word' });
  });

  test('keeps an unterminated quote from eating the rest of the line', () => {
    expect(parseEnvFile('A="oops')).toEqual({ A: 'oops' });
  });

  test('reads an empty value', () => {
    expect(parseEnvFile('A=')).toEqual({ A: '' });
  });

  test('ignores comments and blank lines', () => {
    expect(parseEnvFile('# heading\n\nA=1\n   \nB=2')).toEqual({ A: '1', B: '2' });
  });

  test('ignores lines that are not assignments', () => {
    expect(parseEnvFile('not an assignment\nA=1')).toEqual({ A: '1' });
  });
});
