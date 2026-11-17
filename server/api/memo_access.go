package api

import (
	"context"
	stderrors "errors"
	"sync"

	"github.com/pkg/errors"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/usememos/memos/core/access"
	"github.com/usememos/memos/store"
)

// buildMemoReadContext resolves authorization inputs for exactly one memo.
// Relations never contribute access to either endpoint.
func (s *APIService) buildMemoReadContext(ctx context.Context, memo *store.Memo, sharedMemoID *int32) (access.MemoReadContext, error) {
	viewer, err := s.fetchCurrentUser(ctx)
	if err != nil {
		return access.MemoReadContext{}, status.Errorf(codes.Internal, "failed to get user")
	}
	allowAnonymous := false
	if viewer == nil {
		allowAnonymous, err = s.allowsAnonymousAccess(ctx)
		if err != nil {
			return access.MemoReadContext{}, status.Errorf(codes.Internal, "failed to resolve instance access policy")
		}
	}
	return s.buildMemoReadContextForViewer(ctx, memo, viewer, allowAnonymous, sharedMemoID)
}

func (s *APIService) buildMemoReadContextForViewer(ctx context.Context, memo *store.Memo, viewer *store.User, allowAnonymous bool, sharedMemoID *int32) (access.MemoReadContext, error) {
	if memo == nil {
		return access.MemoReadContext{}, status.Error(codes.NotFound, "memo not found")
	}
	readContext, err := access.ResolveMemoReadContext(ctx, s.memoReadStore(ctx), memo, viewer, allowAnonymous, sharedMemoID)
	if err != nil {
		return access.MemoReadContext{}, status.Errorf(codes.Internal, "failed to resolve memo access")
	}
	return readContext, nil
}

func (s *APIService) checkMemoReadAccess(ctx context.Context, memo *store.Memo) error {
	readContext, err := s.buildMemoReadContext(ctx, memo, nil)
	if err != nil {
		return err
	}
	return memoAccessDecisionError(access.CheckMemoReadContext(readContext))
}

func memoAccessDecisionError(decision access.MemoReadDecision) error {
	switch decision.Denial {
	case access.MemoReadDenialNone:
		return nil
	case access.MemoReadDenialNotFound:
		return status.Error(codes.NotFound, "memo not found")
	case access.MemoReadDenialUnauthenticated:
		return status.Error(codes.Unauthenticated, "user not authenticated")
	default:
		return status.Error(codes.PermissionDenied, "permission denied")
	}
}

// newMemoAccessScope returns the memo-local authorization predicate for a
// caller. Drivers apply it as a database predicate before LIMIT/OFFSET so
// inaccessible rows can neither leak nor skew counts and pagination.
func newMemoAccessScope(currentUser *store.User, allowPublic bool) *store.MemoAccessScope {
	accessScope := &store.MemoAccessScope{AllowPublic: allowPublic, AllowProtected: currentUser != nil}
	if currentUser != nil {
		accessScope.UserID = &currentUser.ID
	}
	return accessScope
}

// resolveMemoAccessScope resolves the caller and builds their memo access
// scope. For an anonymous caller the instance access policy decides whether
// PUBLIC memos are readable at all. Callers map the returned error to their own
// transport representation.
func (s *APIService) resolveMemoAccessScope(ctx context.Context) (*store.MemoAccessScope, *store.User, error) {
	currentUser, err := s.fetchCurrentUser(ctx)
	if err != nil {
		return nil, nil, errors.Wrap(err, "failed to get current user")
	}
	allowPublic := currentUser != nil
	if currentUser == nil {
		allowPublic, err = s.Store.AllowsAnonymousAccess(ctx)
		if err != nil {
			return nil, nil, errors.Wrap(err, "failed to resolve instance access policy")
		}
	}
	return newMemoAccessScope(currentUser, allowPublic), currentUser, nil
}

// resolveSpaceByName resolves a space resource name to an existing Space
// without any membership check.
func (s *APIService) resolveSpaceByName(ctx context.Context, name string) (*store.Space, error) {
	spaceUID, err := ExtractSpaceUIDFromName(name)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid space name: %v", err)
	}
	space, err := s.Store.GetSpace(ctx, &store.FindSpace{UID: &spaceUID})
	if err != nil {
		return nil, status.Error(codes.Internal, "failed to get space")
	}
	if space == nil {
		return nil, status.Error(codes.NotFound, "space not found")
	}
	return space, nil
}

// resolveWritableSpaceByName resolves a space resource name and requires the
// caller to be an active member of it. A non-member receives NotFound so that
// an existing collaboration boundary stays indistinguishable from a missing
// resource.
func (s *APIService) resolveWritableSpaceByName(ctx context.Context, name string, userID int32) (*store.Space, error) {
	space, err := s.resolveSpaceByName(ctx, name)
	if err != nil {
		return nil, err
	}
	active, err := s.isActiveSpaceMember(ctx, space.ID, userID)
	if err != nil {
		return nil, status.Error(codes.Internal, "failed to resolve space membership")
	}
	if !active {
		return nil, status.Error(codes.NotFound, "space not found")
	}
	return space, nil
}

// resolveSpaceForMemoPlacement resolves the Space a memo is being placed in.
// An instance administrator may place memos in any existing Space; every
// other caller must be an active member. Collection scopes such as the space
// filter keep using resolveWritableSpaceByName, so feeds stay membership-only.
func (s *APIService) resolveSpaceForMemoPlacement(ctx context.Context, name string, user *store.User) (*store.Space, error) {
	if access.IsInstanceAdmin(user) {
		return s.resolveSpaceByName(ctx, name)
	}
	return s.resolveWritableSpaceByName(ctx, name, user.ID)
}

func (s *APIService) isActiveSpaceMember(ctx context.Context, spaceID, userID int32) (bool, error) {
	user, err := s.Store.GetUser(ctx, &store.FindUser{ID: &userID})
	if err != nil {
		return false, err
	}
	if user == nil || user.RowStatus != store.Normal {
		return false, nil
	}
	membership, err := s.Store.GetSpaceMember(ctx, &store.FindSpaceMember{SpaceID: &spaceID, UserID: &userID})
	if err != nil {
		return false, err
	}
	return membership != nil && membership.Role.IsActiveMember(), nil
}

func sameOptionalInt32(left, right *int32) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func memoWritePolicy(actorUserID int32, lifecycleOnly bool) *store.MemoWritePolicy {
	return &store.MemoWritePolicy{
		ActorUserID:   actorUserID,
		LifecycleOnly: lifecycleOnly,
	}
}

func mapMemoWriteError(err error, operation string) error {
	switch {
	case stderrors.Is(err, store.ErrMemoMutationConflict):
		return status.Errorf(codes.FailedPrecondition, "memo state changed: %v", err)
	case stderrors.Is(err, store.ErrMemoSpaceNotWritable):
		return status.Error(codes.FailedPrecondition, "memo space is no longer writable")
	case stderrors.Is(err, store.ErrMemoSpaceMembershipRequired), stderrors.Is(err, store.ErrMemoPermissionDenied):
		return status.Error(codes.PermissionDenied, "permission denied")
	case stderrors.Is(err, store.ErrMemoShareConflict):
		return status.Error(codes.FailedPrecondition, "revoke active shares before using the SPACE audience")
	default:
		return status.Errorf(codes.Internal, "%s: %v", operation, err)
	}
}

// requireAssignedMemoWritable requires the placement of an assigned memo to be
// valid and the actor to be an active member of it. An instance administrator
// is exempt from membership but not from placement validity.
func (s *APIService) requireAssignedMemoWritable(ctx context.Context, memo *store.Memo, user *store.User) error {
	if memo.SpaceID == nil {
		return nil
	}
	space, err := s.Store.GetSpace(ctx, &store.FindSpace{ID: memo.SpaceID})
	if err != nil {
		return status.Errorf(codes.Internal, "failed to get memo space")
	}
	if space == nil {
		return status.Errorf(codes.FailedPrecondition, "memo has invalid space placement")
	}
	if access.IsInstanceAdmin(user) {
		return nil
	}
	active, err := s.isActiveSpaceMember(ctx, space.ID, user.ID)
	if err != nil {
		return status.Errorf(codes.Internal, "failed to resolve space membership")
	}
	if !active {
		return status.Errorf(codes.PermissionDenied, "active space membership is required")
	}
	return nil
}

type memoReadCacheKey struct{}

// memoReadCache holds the Space reads of one memo list conversion, so the memos
// of a page that share a Space look it and the viewer's membership up once. It
// lives only as long as the request that lists them.
type memoReadCache struct {
	store *store.Store

	mu             sync.Mutex
	spaces         map[int32]*store.Space
	members        map[memoReadMemberKey]*store.SpaceMember
	allowAnonymous *bool
}

type memoReadMemberKey struct {
	spaceID int32
	userID  int32
}

// withMemoReadCache returns a context whose memo read contexts and placement
// projections share one memoReadCache.
func withMemoReadCache(ctx context.Context, s *store.Store) context.Context {
	return context.WithValue(ctx, memoReadCacheKey{}, &memoReadCache{
		store:   s,
		spaces:  map[int32]*store.Space{},
		members: map[memoReadMemberKey]*store.SpaceMember{},
	})
}

// memoReadStore returns the context's memoReadCache, or the store itself.
func (s *APIService) memoReadStore(ctx context.Context) access.MemoReadStore {
	if cache, ok := ctx.Value(memoReadCacheKey{}).(*memoReadCache); ok {
		return cache
	}
	return s.Store
}

func (s *APIService) allowsAnonymousAccess(ctx context.Context) (bool, error) {
	cache, ok := ctx.Value(memoReadCacheKey{}).(*memoReadCache)
	if !ok {
		return s.Store.AllowsAnonymousAccess(ctx)
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.allowAnonymous == nil {
		allow, err := s.Store.AllowsAnonymousAccess(ctx)
		if err != nil {
			return false, err
		}
		cache.allowAnonymous = &allow
	}
	return *cache.allowAnonymous, nil
}

func (c *memoReadCache) GetUser(ctx context.Context, find *store.FindUser) (*store.User, error) {
	return c.store.GetUser(ctx, find)
}

func (c *memoReadCache) GetSpace(ctx context.Context, find *store.FindSpace) (*store.Space, error) {
	if find.ID == nil || len(find.IDList) > 0 || find.UID != nil || find.MemberUserID != nil || find.Limit != nil || find.Offset != nil {
		return c.store.GetSpace(ctx, find)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if space, ok := c.spaces[*find.ID]; ok {
		return space, nil
	}
	space, err := c.store.GetSpace(ctx, find)
	if err != nil {
		return nil, err
	}
	c.spaces[*find.ID] = space
	return space, nil
}

func (c *memoReadCache) GetSpaceMember(ctx context.Context, find *store.FindSpaceMember) (*store.SpaceMember, error) {
	if find.SpaceID == nil || find.UserID == nil || find.ViewerUserID != nil || find.Limit != nil || find.Offset != nil {
		return c.store.GetSpaceMember(ctx, find)
	}
	key := memoReadMemberKey{spaceID: *find.SpaceID, userID: *find.UserID}
	c.mu.Lock()
	defer c.mu.Unlock()
	if member, ok := c.members[key]; ok {
		return member, nil
	}
	member, err := c.store.GetSpaceMember(ctx, find)
	if err != nil {
		return nil, err
	}
	c.members[key] = member
	return member, nil
}
