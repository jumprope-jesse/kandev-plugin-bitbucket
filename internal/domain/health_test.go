package domain

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestHealthScheduleUsesNinetySecondJitteredBackoff(t *testing.T) {
	schedule := NewHealthSchedule(func() float64 { return 0.5 })

	require.Equal(t, 90*time.Second, schedule.Next(0))
	require.Equal(t, 180*time.Second, schedule.Next(1))

	lowJitter := NewHealthSchedule(func() float64 { return 0.0 })
	highJitter := NewHealthSchedule(func() float64 { return 1.0 })
	require.Equal(t, 81*time.Second, lowJitter.Next(0))
	require.Equal(t, 99*time.Second, highJitter.Next(0))
}
