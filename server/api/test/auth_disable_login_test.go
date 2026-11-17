package test

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	apipb "github.com/usememos/memos/proto/gen/api"
	"github.com/usememos/memos/server/api"
	"github.com/usememos/memos/server/auth"
)

func TestRefreshTokenDisableLogin(t *testing.T) {
	ctx := context.Background()

	t.Run("signs in as the oldest admin", func(t *testing.T) {
		t.Setenv("MEMOS_DISABLE_LOGIN", "true")
		ts := NewTestService(t)
		defer ts.Cleanup()
		_, err := ts.CreateRegularUser(ctx, "regular")
		require.NoError(t, err)
		admin, err := ts.CreateHostUser(ctx, "admin")
		require.NoError(t, err)
		_, err = ts.CreateHostUser(ctx, "second-admin")
		require.NoError(t, err)

		resp, err := api.NewConnectServiceHandler(ts.Service).RefreshToken(ctx, connect.NewRequest(&apipb.RefreshTokenRequest{}))
		require.NoError(t, err)
		require.Contains(t, resp.Header().Get("Set-Cookie"), auth.RefreshTokenCookieName)

		claims, err := auth.NewAuthenticator(ts.Store, ts.Secret).AuthenticateByAccessTokenV2(ctx, resp.Msg.AccessToken)
		require.NoError(t, err)
		require.Equal(t, admin.ID, claims.UserID)
	})

	t.Run("fails without an admin", func(t *testing.T) {
		t.Setenv("MEMOS_DISABLE_LOGIN", "true")
		ts := NewTestService(t)
		defer ts.Cleanup()

		_, err := api.NewConnectServiceHandler(ts.Service).RefreshToken(ctx, connect.NewRequest(&apipb.RefreshTokenRequest{}))
		require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
	})

	t.Run("requires a refresh token when unset", func(t *testing.T) {
		ts := NewTestService(t)
		defer ts.Cleanup()
		_, err := ts.CreateHostUser(ctx, "admin")
		require.NoError(t, err)

		_, err = api.NewConnectServiceHandler(ts.Service).RefreshToken(ctx, connect.NewRequest(&apipb.RefreshTokenRequest{}))
		require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
	})
}
