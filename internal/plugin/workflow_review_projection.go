package plugin

import (
	"context"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
)

func parseReviewProjection(include []string) (domain.ReviewProjection, error) {
	if len(include) == 0 {
		return domain.FullReviewProjection(), nil
	}
	projection := domain.ReviewProjection{}
	for _, field := range include {
		switch strings.ToLower(strings.TrimSpace(field)) {
		case "diff":
			projection.Diff = true
		case "files":
			projection.Files = true
		case "commits":
			projection.Commits = true
		case "participants":
			projection.Participants = true
		case "threads":
			projection.Threads = true
		case "status", "statuses":
			projection.Statuses = true
		case "viewer":
			projection.Viewer = true
		case "thread_count":
			projection.ThreadCount = true
		default:
			return domain.ReviewProjection{}, invalidActionError("unsupported review projection %q", field)
		}
	}
	return projection, nil
}

func projectedReview(
	ctx context.Context,
	provider domain.Provider,
	repository domain.Repository,
	number int,
	projection domain.ReviewProjection,
) (domain.Review, error) {
	if projected, ok := provider.(domain.ProjectedReviewProvider); ok {
		review, err := projected.GetReviewProjected(ctx, repository, number, projection)
		return restrictReviewProjection(review, projection), err
	}
	review, err := provider.GetReview(ctx, repository, number)
	return restrictReviewProjection(review, projection), err
}

func restrictReviewProjection(review domain.Review, projection domain.ReviewProjection) domain.Review {
	if !projection.Diff {
		review.Diff = ""
		for index := range review.Files {
			review.Files[index].Patch = ""
		}
	}
	if !projection.Files {
		review.Files = nil
	}
	if !projection.Commits {
		review.Commits = nil
	}
	if !projection.Participants {
		review.Participants = nil
	}
	if !projection.Threads {
		review.Threads = nil
	}
	if !projection.Statuses {
		review.Statuses = nil
	}
	if !projection.Viewer {
		review.ViewerID = ""
	}
	if !projection.ThreadCount {
		review.UnresolvedThreadCount = nil
	}
	return review
}
