import { InvalidColumnFilterError } from '@adonis-agora/filter';
import { describe, expect, it } from 'vitest';
import { parseListQuery } from '../../src/http/list.js';

const options = {
  sortable: ['createdAt'],
  defaultSort: { field: 'createdAt', direction: 'desc' as const },
  filterable: ['operation'],
};

describe('parseListQuery', () => {
  it('reads equality filters', () => {
    expect(parseListQuery({ 'filter[operation]': 'encrypt' }, options).filters).toEqual({
      operation: 'encrypt',
    });
  });

  it('refuses reserved names as filter fields or operators', () => {
    for (const key of [
      'filter[__proto__]',
      'filter[__proto__][x]',
      'filter[constructor]',
      'filter[operation][__proto__]',
    ]) {
      expect(() => parseListQuery({ [key]: '1' }, options)).toThrow(InvalidColumnFilterError);
    }
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('ignores a reserved top-level key', () => {
    const query = JSON.parse('{"__proto__":{"filter":{"operation":"x"}}}') as Record<
      string,
      unknown
    >;
    expect(parseListQuery(query, options).filters).toEqual({});
  });
});
