defmodule GrappaWeb.OidcControllerTest do
  @moduledoc """
  The OIDC doors end to end (#1911).

  The two `/auth/oidc` actions are driven as the NAVIGATIONS they are:
  `authorize` is followed to its redirect, and `callback` is read out of
  the `#oidc=` fragment it sends the SPA home with. The provider is faked
  at the seams the flow itself names — the discovery document, the JWKS,
  and a Bypass token endpoint — so what runs is the real round trip: a
  state minted by `authorize`, a `code` spent at the token endpoint, an
  `id_token` signed by the key the provider publishes.
  """

  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Accounts
  alias Grappa.Auth.Oidc
  alias Grappa.Auth.Oidc.{Config, Discovery, Jwks}
  alias Grappa.RateLimit.FailureWindow
  alias Grappa.Repo

  @issuer "https://idm.example.com"
  @client_id "grappa"
  @redirect_uri "https://grappa.example.com/auth/oidc/callback"
  @kid "test-signing-key"
  @subject "kanidm-subject-1"
  @authorize_endpoint "https://idm.example.com/ui/authorize"
  @jwks_uri "https://idm.example.com/oidc/jwks"

  # Same move, same reason, as `clear_totp_window/1` in
  # `GrappaWeb.AuthControllerTest`: the bucket is a private constant of
  # the controller, and the window beneath it is process-global ETS this
  # module must leave empty behind itself.
  @oidc_bucket :oidc_login
  @oidc_max_failures 10

  @config %Config{
    issuer: @issuer,
    client_id: @client_id,
    client_secret: "s3cret",
    redirect_uri: @redirect_uri,
    scopes: "openid profile email"
  }

  # A REAL P-256 keypair, generated once per test run. Hand-typed
  # coordinates cannot sign — OpenSSL refuses a key whose public point is
  # not on the curve (`Can't EVP_PKEY_sign`). The JWKS handed to the flow
  # carries the public half only, exactly as a provider's does.
  signing_key = JOSE.JWK.generate_key({:ec, "P-256"})
  {_, signing_map} = JOSE.JWK.to_map(signing_key)

  @jwk Map.put(signing_map, "kid", @kid)

  setup do
    Config.put_test_config(nil)
    :ok = FailureWindow.clear(@oidc_bucket, "127.0.0.1")

    on_exit(fn ->
      Config.put_test_config(nil)
      :ok = FailureWindow.clear(@oidc_bucket, "127.0.0.1")
    end)

    %{bypass: Bypass.open()}
  end

  describe "with no provider configured" do
    test "both legs of the round trip answer 404 — the door does not exist", %{conn: conn} do
      assert conn |> get("/auth/oidc/authorize") |> response(404)

      assert conn
             |> get("/auth/oidc/callback", %{"code" => "c", "state" => "s"})
             |> response(404)
    end

    test "the /me/oidc surfaces answer 404 too", %{conn: conn} do
      {_user, session} = user_and_session()
      conn = put_bearer(conn, session.id)

      assert conn |> get("/me/oidc") |> response(404)
      assert conn |> post("/me/oidc/link", %{}) |> response(404)
      assert conn |> delete("/me/oidc") |> response(404)
    end
  end

  describe "GET /auth/oidc/authorize" do
    setup %{bypass: bypass} do
      seed_provider(bypass)
      :ok
    end

    test "redirects to the discovered authorization endpoint with the PKCE question", %{
      conn: conn
    } do
      conn = get(conn, "/auth/oidc/authorize")
      assert location = redirected_to(conn, 302)
      assert String.starts_with?(location, @authorize_endpoint <> "?")

      params = URI.decode_query(URI.parse(location).query)

      assert params["response_type"] == "code"
      assert params["client_id"] == @client_id
      assert params["redirect_uri"] == @redirect_uri
      assert params["scope"] == "openid profile email"
      assert params["code_challenge_method"] == "S256"
      # RFC 7636 §4.1: a 43-char base64url verifier hash, unpadded.
      assert byte_size(params["code_challenge"]) == 43
      refute params["state"] in [nil, ""]
      refute params["nonce"] in [nil, ""]
    end

    test "each round trip mints a fresh state and nonce", %{conn: conn} do
      first = authorize_params(conn)
      second = authorize_params(conn)

      assert first["state"] != second["state"]
      assert first["nonce"] != second["nonce"]
    end

    test "refuses once the failure window is full", %{conn: conn} do
      charge_window(@oidc_max_failures)

      assert %{"kind" => "error", "code" => "too_many_attempts"} =
               conn |> get("/auth/oidc/authorize") |> redirected_payload()
    end
  end

  describe "GET /auth/oidc/callback" do
    setup %{bypass: bypass} do
      seed_provider(bypass)
      :ok
    end

    test "a linked account comes home with a bearer session in the fragment", %{
      conn: conn,
      bypass: bypass
    } do
      user = user_fixture()
      {:ok, _} = Oidc.link_identity(user.id, @issuer, @subject, "vjt")

      %{"state" => state, "nonce" => nonce} = authorize_params(conn)
      stub_token_endpoint(bypass, id_token(nonce))

      payload =
        conn
        |> get("/auth/oidc/callback", %{"code" => "one-use-code", "state" => state})
        |> redirected_payload()

      assert %{"kind" => "session", "token" => token, "subject" => subject} = payload
      assert %{"kind" => "user", "id" => id, "name" => name} = subject
      assert id == user.id
      assert name == user.name

      # The bearer is a REAL session, not a string that crossed the
      # fragment for looks.
      assert %Accounts.Session{} = Repo.get_by(Accounts.Session, id: token)
    end

    test "a round trip is spent once: replaying its state refuses", %{
      conn: conn,
      bypass: bypass
    } do
      user = user_fixture()
      {:ok, _} = Oidc.link_identity(user.id, @issuer, @subject, "vjt")

      %{"state" => state, "nonce" => nonce} = authorize_params(conn)
      stub_token_endpoint(bypass, id_token(nonce))

      assert %{"kind" => "session"} =
               conn
               |> get("/auth/oidc/callback", %{"code" => "one-use-code", "state" => state})
               |> redirected_payload()

      assert %{"kind" => "error", "code" => "invalid_state"} =
               conn
               |> get("/auth/oidc/callback", %{"code" => "another-code", "state" => state})
               |> redirected_payload()
    end

    test "a provider identity nobody linked is refused, not provisioned", %{
      conn: conn,
      bypass: bypass
    } do
      %{"state" => state, "nonce" => nonce} = authorize_params(conn)
      stub_token_endpoint(bypass, id_token(nonce))

      assert %{"kind" => "error", "code" => "not_linked"} =
               conn
               |> get("/auth/oidc/callback", %{"code" => "one-use-code", "state" => state})
               |> redirected_payload()
    end

    test "a forged state is refused AND charged", %{conn: conn} do
      charge_window(@oidc_max_failures - 1)

      assert %{"kind" => "error", "code" => "invalid_state"} =
               conn
               |> get("/auth/oidc/callback", %{"code" => "c", "state" => "forged"})
               |> redirected_payload()

      # Nine charged here, the tenth by the refusal itself: the window is
      # exactly full, and one fewer would still have admitted.
      assert {:error, :limited} =
               FailureWindow.check(@oidc_bucket, "127.0.0.1", @oidc_max_failures)

      assert :ok = FailureWindow.check(@oidc_bucket, "127.0.0.1", @oidc_max_failures + 1)
    end

    test "the charge that closes the window names its own door on the admin stream", %{
      conn: conn
    } do
      charge_window(@oidc_max_failures - 1)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.admin_events())

      assert %{"kind" => "error", "code" => "invalid_state"} =
               conn
               |> get("/auth/oidc/callback", %{"code" => "c", "state" => "forged"})
               |> redirected_payload()

      # The signal a mute door would have swallowed: the operator reads
      # WHICH credential door is being forged at, not merely that requests
      # started failing. Emitted on the crossing charge only, like every
      # door that goes through `GrappaWeb.LoginThrottle`.
      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       payload: %{
                         kind: :login_throttled,
                         door: :oidc_login,
                         scope: :ip,
                         source_ip: "127.0.0.1",
                         failures: @oidc_max_failures
                       }
                     },
                     500
    end

    test "the provider's own refusal comes home as provider_refused", %{conn: conn} do
      %{"state" => state} = authorize_params(conn)

      assert %{"kind" => "error", "code" => "provider_refused"} =
               conn
               |> get("/auth/oidc/callback", %{"error" => "access_denied", "state" => state})
               |> redirected_payload()
    end

    test "a callback with neither a code nor an error is refused as an invalid state", %{
      conn: conn
    } do
      assert %{"kind" => "error", "code" => "invalid_state"} =
               conn |> get("/auth/oidc/callback", %{}) |> redirected_payload()
    end

    test "a code the provider will not redeem comes home as invalid_code", %{
      conn: conn,
      bypass: bypass
    } do
      Bypass.expect_once(bypass, "POST", "/token", fn conn ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.resp(400, Jason.encode!(%{"error" => "invalid_grant"}))
      end)

      %{"state" => state} = authorize_params(conn)

      assert %{"kind" => "error", "code" => "invalid_code"} =
               conn
               |> get("/auth/oidc/callback", %{"code" => "already-spent", "state" => state})
               |> redirected_payload()
    end
  end

  describe "the /me/oidc link surfaces" do
    setup %{bypass: bypass} do
      seed_provider(bypass)
      {user, session} = user_and_session()

      %{user: user, conn: put_bearer(build_conn(), session.id)}
    end

    test "an unlinked account reads a nil identity", %{conn: conn} do
      assert %{"identity" => nil} = conn |> get("/me/oidc") |> json_response(200)
    end

    test "link hands back the provider's authorize URL, and completing it writes the link", %{
      conn: conn,
      bypass: bypass,
      user: user
    } do
      assert %{"authorize_url" => url} = conn |> post("/me/oidc/link", %{}) |> json_response(200)
      assert String.starts_with?(url, @authorize_endpoint <> "?")

      %{"state" => state, "nonce" => nonce} = URI.decode_query(URI.parse(url).query)
      stub_token_endpoint(bypass, id_token(nonce))

      # The callback is driven by a bare conn — no bearer, no session.
      # The link can therefore only land on the account the round trip
      # was minted for, which is the property under test.
      assert %{"kind" => "linked", "label" => "vjt"} =
               build_conn()
               |> get("/auth/oidc/callback", %{"code" => "one-use-code", "state" => state})
               |> redirected_payload()

      assert {:ok, linked} = Oidc.find_identity(@issuer, @subject)
      assert linked.user_id == user.id

      assert %{"identity" => %{"label" => "vjt", "linked_at" => linked_at}} =
               conn |> get("/me/oidc") |> json_response(200)

      assert is_binary(linked_at)
    end

    test "unlink removes the link and a second one is honest about it", %{conn: conn, user: user} do
      {:ok, _} = Oidc.link_identity(user.id, @issuer, @subject, "vjt")

      assert %{"identity" => nil} = conn |> delete("/me/oidc") |> json_response(200)
      assert %{"error" => "not_found"} = conn |> delete("/me/oidc") |> json_response(404)
      assert {:error, :not_found} = Oidc.find_identity(@issuer, @subject)
    end

    test "a per-client token is refused by the pipeline, not by this controller", %{user: user} do
      {:ok, token} = Accounts.create_client_token(user, "headless", nil, nil, [])

      assert %{"error" => "client_token_scope"} =
               build_conn()
               |> put_bearer(token.id)
               |> get("/me/oidc")
               |> json_response(403)
    end
  end

  ## Helpers — the fake provider, the round trip, the fragment

  # Seeds the door the way `Grappa.Auth.Oidc.Config.boot/0` +
  # `Discovery.fetch/1` would have left it. The discovery document is PUT
  # rather than fetched on purpose: its HTTPS-only rule is
  # `Grappa.Auth.Oidc.DiscoveryTest`'s subject, and the token endpoint
  # under test here is a local Bypass.
  defp seed_provider(bypass) do
    Config.put_test_config(@config)

    :ok =
      Discovery.put_test_discovery(@issuer, %Discovery{
        issuer: @issuer,
        authorization_endpoint: @authorize_endpoint,
        token_endpoint: "http://localhost:#{bypass.port}/token",
        jwks_uri: @jwks_uri
      })

    :ok = Jwks.put_test_keys(@jwks_uri, [Map.delete(@jwk, "d")])

    on_exit(fn ->
      :persistent_term.erase({Discovery, @issuer})
      :persistent_term.erase({Jwks, @jwks_uri})
    end)

    :ok
  end

  defp authorize_params(conn) do
    conn = get(conn, "/auth/oidc/authorize")
    assert location = redirected_to(conn, 302)
    assert String.starts_with?(location, @authorize_endpoint <> "?")

    URI.decode_query(URI.parse(location).query)
  end

  defp stub_token_endpoint(bypass, id_token) do
    Bypass.expect_once(bypass, "POST", "/token", fn conn ->
      body =
        Jason.encode!(%{
          "access_token" => "access-token",
          "token_type" => "Bearer",
          "id_token" => id_token
        })

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.resp(200, body)
    end)
  end

  defp id_token(nonce) do
    claims = %{
      "iss" => @issuer,
      "aud" => @client_id,
      "sub" => @subject,
      "nonce" => nonce,
      "exp" => System.system_time(:second) + 300,
      "preferred_username" => "vjt"
    }

    # Key, header, claims — `JOSE.JWT.sign/3`'s argument order, NOT a
    # pipe off the claims (see `compact_jws/3` in `IdTokenTest`).
    {_, compact} =
      JOSE.JWT.sign(JOSE.JWK.from_map(@jwk), %{"alg" => "ES256", "kid" => @kid}, claims)
      |> JOSE.JWS.compact()

    compact
  end

  defp charge_window(times) do
    for _ <- 1..times,
        do: FailureWindow.record_failure(@oidc_bucket, "127.0.0.1", :timer.minutes(15))

    :ok
  end

  # The SPA landing: `#oidc=` + base64url JSON, the #1404 move. Read back
  # here the way `cicchetto/src/lib/oidc.ts` reads it in the browser.
  defp redirected_payload(conn) do
    location = redirected_to(conn, 302)
    assert String.starts_with?(location, "/login#oidc=")

    encoded = String.replace_prefix(location, "/login#oidc=", "")
    assert {:ok, raw} = Base.url_decode64(encoded, padding: false)
    assert {:ok, payload} = Jason.decode(raw)

    payload
  end
end
