/** @jsxImportSource hono/jsx */
import { test, expect, describe } from 'bun:test';
import { Creature } from '../../../src/web/creature/Creature';
import { tokens } from '../../../src/web/tokens/tokens';

describe('Creature SSR', () => {
  test('renders a juvenile cat without throwing, contains <pre>', () => {
    const html = String(<Creature species="cat" />);
    expect(html).toContain('<pre');
  });

  test('juvenile cat contains all 3 ASCII art lines', () => {
    const html = String(<Creature species="cat" mood="neutral" stage="juvenile" />);
    // Head line
    expect(html).toContain('/\\_/\\');
    // Face line
    expect(html).toContain('(o.o)');
    // Legs line
    expect(html).toContain('&gt; ^ &lt;');
  });

  test('egg stage renders egg art', () => {
    const html = String(<Creature species="cat" stage="egg" />);
    expect(html).toContain('.--.');
    expect(html).toContain('____');
  });

  test('adult stage contains ★ aura corners', () => {
    const html = String(<Creature species="cat" stage="adult" />);
    expect(html).toContain('★');
  });

  test('uses mono font family from tokens', () => {
    const html = String(<Creature species="slime" />);
    expect(html).toContain('JetBrains Mono');
  });

  test('custom color is applied', () => {
    const html = String(<Creature species="slime" color={tokens.color.terra} />);
    expect(html).toContain(tokens.color.terra);
  });

  test('cell prop controls font size via size = max(9, round(cell*3+4))', () => {
    // cell=6 → size = max(9, round(22)) = 22
    const html6 = String(<Creature species="slime" cell={6} />);
    expect(html6).toContain('font-size:22');

    // cell=1 → size = max(9, round(7)) = 9
    const html1 = String(<Creature species="slime" cell={1} />);
    expect(html1).toContain('font-size:9');
  });

  test('defaults: mood=neutral, stage=juvenile, cell=6', () => {
    const html = String(<Creature species="slime" />);
    // slime-neutral-juvenile face line
    expect(html).toContain('/o o\\');
    // not egg
    expect(html).not.toContain('.--.');
    // not adult (no ★)
    expect(html).not.toContain('★');
    // cell=6 → font-size 22
    expect(html).toContain('font-size:22');
  });

  test('robot renders with block characters in face', () => {
    const html = String(<Creature species="robot" mood="neutral" stage="juvenile" />);
    expect(html).toContain('■_■');
  });
});
