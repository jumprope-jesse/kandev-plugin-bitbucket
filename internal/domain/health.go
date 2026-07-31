package domain

import (
	"math"
	"math/rand/v2"
	"time"
)

const (
	healthInterval = 90 * time.Second
	healthJitter   = 0.10
	maxHealthDelay = 15 * time.Minute
)

// HealthSchedule computes bounded, jittered health-probe delays.
type HealthSchedule struct {
	random func() float64
}

// NewHealthSchedule creates a health schedule. Random values should be in [0, 1].
func NewHealthSchedule(random func() float64) HealthSchedule {
	if random == nil {
		random = rand.Float64
	}
	return HealthSchedule{random: random}
}

// Next returns the next delay; failures apply capped exponential backoff.
func (s HealthSchedule) Next(consecutiveFailures int) time.Duration {
	if consecutiveFailures < 0 {
		consecutiveFailures = 0
	}
	delay := float64(healthInterval) * math.Pow(2, float64(consecutiveFailures))
	if delay > float64(maxHealthDelay) {
		delay = float64(maxHealthDelay)
	}
	random := s.random()
	if random < 0 {
		random = 0
	}
	if random > 1 {
		random = 1
	}
	return time.Duration(delay * (1 + (random-0.5)*2*healthJitter))
}
