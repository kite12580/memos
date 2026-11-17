package api

import (
	"cmp"
	"context"
	"os"
	"slices"
	"strconv"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	apipb "github.com/usememos/memos/proto/gen/api"
	"github.com/usememos/memos/store"
)

const disableLoginEnv = "MEMOS_DISABLE_LOGIN"

func isLoginDisabled() bool {
	disabled, _ := strconv.ParseBool(os.Getenv(disableLoginEnv))
	return disabled
}

// refreshTokenOrAutoLogin signs a caller without a usable refresh token in as
// the oldest active admin when MEMOS_DISABLE_LOGIN is true.
func (s *APIService) refreshTokenOrAutoLogin(ctx context.Context, request *apipb.RefreshTokenRequest) (*apipb.RefreshTokenResponse, error) {
	resp, err := s.RefreshToken(ctx, request)
	if err == nil || status.Code(err) != codes.Unauthenticated || !isLoginDisabled() {
		return resp, err
	}

	role, rowStatus := store.RoleAdmin, store.Normal
	admins, err := s.Store.ListUsers(ctx, &store.FindUser{Role: &role, RowStatus: &rowStatus})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list admin users: %v", err)
	}
	if len(admins) == 0 {
		return nil, status.Errorf(codes.Unauthenticated, "no admin user to sign in as")
	}
	admin := slices.MinFunc(admins, func(a, b *store.User) int { return cmp.Compare(a.ID, b.ID) })

	accessToken, expiresAt, err := s.doSignIn(ctx, admin)
	if err != nil {
		return nil, err
	}
	return &apipb.RefreshTokenResponse{
		AccessToken:           accessToken,
		AccessTokenExpireTime: timestamppb.New(expiresAt),
	}, nil
}
