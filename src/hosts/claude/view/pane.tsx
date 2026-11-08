import type { Elements } from 'claude-code'

import type { Card, Row, ViewModel } from './model'

// The detail view's elements (DESIGN, "The detail view"): each card a
// round-bordered Box in the theme's separator colour, each row one Text of
// coloured runs, cut at the card's edge. A prop is left out rather than set
// to undefined.

// Box and Text, which every surface's table has
type Els = Pick<Elements[keyof Elements], 'Box' | 'Text'>

function line({ Text }: Els, row: Row) {
  return (
    <Text wrap="truncate-end">
      {row.map(s => <Text {...(s.color ? { color: s.color } : {})} {...(s.bold ? { bold: true } : {})}>{s.text}</Text>)}
    </Text>
  )
}

function card(els: Els, c: Card, border: string | undefined) {
  const { Box } = els
  return (
    <Box
      borderStyle="round" flexDirection="column" paddingX={1}
      {...(border ? { borderColor: border } : {})}
      {...(c.width ? { width: c.width } : { flexGrow: 1 })}
    >
      {line(els, c.title)}
      {c.rows.map(r => line(els, r))}
    </Box>
  )
}

export function drawView(els: Els, m: ViewModel) {
  const { Box } = els
  return (
    <Box flexDirection="column">
      <Box paddingX={1}>{line(els, m.header)}</Box>
      {m.cards.map(cards => <Box flexDirection="row">{cards.map(c => card(els, c, m.border))}</Box>)}
      <Box paddingX={1}>{line(els, m.footer)}</Box>
    </Box>
  )
}
