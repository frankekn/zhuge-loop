import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLinearMarkers } from '../src/linear.js'

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
