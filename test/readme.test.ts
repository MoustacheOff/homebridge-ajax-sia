import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces turned into hyphens. */
const anchor = (heading: string): string => heading.replace(/`/g, '').trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');

describe('README', () => {
  it('only links to sections that exist', () => {
    const withoutCode = readme.replace(/```[\s\S]*?```/g, '');
    const anchors = new Set([...withoutCode.matchAll(/^#{1,6}\s+(.*)$/gm)].map((match) => anchor(match[1]!)));
    const links = [...withoutCode.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]!);

    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((link) => !anchors.has(link))).toEqual([]);
  });
});
