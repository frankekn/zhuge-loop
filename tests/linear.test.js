import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLinearContext, parseLinearMarkers } from '../src/linear.js'

test('parseLinearMarkers accepts active markers by issue id, identifier, and title', () => {
  const markers = parseLinearMarkers(`
[LINEAR_ACTIVE] issue_id=11111111-1111-4111-8111-111111111111
[LINEAR_ACTIVE] identifier=AIR-601
[LINEAR_ACTIVE] title=Mobile DashboardView: wire IdleDurationAlertCard with one-tap assign CTA into fleet section
`)

  assert.deepEqual(markers.slice(0, 3), [
    { type: 'active', issueId: '11111111-1111-4111-8111-111111111111' },
    { type: 'active', identifier: 'AIR-601' },
    {
      type: 'active',
      title: 'Mobile DashboardView: wire IdleDurationAlertCard with one-tap assign CTA into fleet section',
    },
  ])
})

test('parseLinearMarkers accepts done markers by issue_id, identifier, and title', () => {
  const markers = parseLinearMarkers(`
[LINEAR_DONE] issue_id=22222222-2222-4222-8222-222222222222
[LINEAR_DONE] identifier=AIR-793
[LINEAR_DONE] title=Some task title
`)

  assert.deepEqual(markers, [
    { type: 'done', issueId: '22222222-2222-4222-8222-222222222222' },
    { type: 'done', identifier: 'AIR-793' },
    { type: 'done', title: 'Some task title' },
  ])
})

test('buildLinearContext keeps workflow statuses visible as active tasks', () => {
  const context = buildLinearContext([
    {
      id: '11111111-1111-4111-8111-111111111111',
      identifier: 'AIR-610',
      title: 'Coordinate mobile dashboard handoff',
      status: 'Coordinating',
      priority: 'P1',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      identifier: 'AIR-611',
      title: 'Execute idle duration CTA wiring',
      status: 'Executing',
      priority: 'P1',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      identifier: 'AIR-612',
      title: 'Review fleet section regression coverage',
      status: 'In Review',
      priority: 'P2',
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      identifier: 'AIR-613',
      title: 'Closed task should stay hidden',
      status: 'Done',
      priority: 'P3',
    },
  ])

  assert.match(context, /AIR-610/)
  assert.match(context, /AIR-611/)
  assert.match(context, /AIR-612/)
  assert.doesNotMatch(context, /AIR-613/)
})
