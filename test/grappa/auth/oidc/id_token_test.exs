defmodule Grappa.Auth.Oidc.IdTokenTest do
  @moduledoc """
  The verification ladder of `Grappa.Auth.Oidc.IdToken` (#1911).

  `verify_claims/5` carries every check a forgery has to beat, so the
  claim ladder is exercised directly — one test per check, each turning
  ONLY the claim the check owns. The signature leg runs through `verify/5`
  with a real ES256 keypair over the `put_test_keys/2` +
  `put_test_discovery/2` seams, and the three forgeries that must not get
  past it are a tampered payload, an algorithm outside the allowlist, and
  a `kid` the provider does not publish.
  """

  use ExUnit.Case, async: false

  alias Grappa.Auth.Oidc.{Config, Discovery, IdToken, Jwks}

  @issuer "https://idm.example.com"
  @client_id "grappa"
  @kid "test-signing-key"

  # A real P-256 keypair (x/y are the public point, d the private scalar),
  # GENERATED once per test run and held in module attributes. Hand-typed
  # coordinates are not an option: OpenSSL refuses to sign with a key whose
  # public point is not on the curve (`Can't EVP_PKEY_sign`), so only a real
  # keypair exercises the ES256 leg. `@jwk` is the private half used to
  # SIGN; the provider's JWKS carries the public half only.
  provider_key = JOSE.JWK.generate_key({:ec, "P-256"})
  {_, provider_map} = JOSE.JWK.to_map(provider_key)
  @jwk Map.put(provider_map, "kid", @kid)
  @jwks %{"keys" => [Map.delete(@jwk, "d")]}

  # A second, unpublished keypair: what a forger signs with. Same `kid`
  # as the provider's key on purpose — naming the published key is free
  # to an attacker, and must not buy verification.
  forged_key = JOSE.JWK.generate_key({:ec, "P-256"})
  {_, forged_map} = JOSE.JWK.to_map(forged_key)
  @forged_jwk Map.put(forged_map, "kid", @kid)

  @config %Config{
    issuer: @issuer,
    client_id: @client_id,
    client_secret: "s3cret",
    redirect_uri: "https://grappa.example.com/auth/oidc/callback",
    scopes: "openid"
  }

  @discovery %Discovery{
    issuer: @issuer,
    authorization_endpoint: "https://idm.example.com/ui/authorize",
    token_endpoint: "https://idm.example.com/oidc/token",
    jwks_uri: "https://idm.example.com/oidc/jwks"
  }

  @nonce "test-nonce"
  @now 1_760_000_000

  setup do
    :ok = Jwks.put_test_keys(@discovery.jwks_uri, @jwks["keys"])
    on_exit(fn -> :persistent_term.erase({Jwks, @discovery.jwks_uri}) end)
    :ok
  end

  defp claims(overrides \\ []) do
    now = @now

    base = %{
      "iss" => @issuer,
      "aud" => @client_id,
      "exp" => now + 300,
      "nonce" => @nonce,
      "sub" => "subject-1",
      "preferred_username" => "vjt@example.com"
    }

    # Overrides arrive as a keyword list, the base carries STRING keys (the
    # shape a real token has), so each key is coerced before it is applied —
    # `Map.put(acc, :sub, "")` adds a SECOND sub and leaves the real one
    # standing, which turns every "refused" assertion into a false green and
    # every "accepted" one into a red.
    Enum.reduce(overrides, base, fn
      {key, nil}, acc -> Map.delete(acc, to_string(key))
      {key, value}, acc -> Map.put(acc, to_string(key), value)
    end)
  end

  describe "verify_claims/5 — the claim ladder" do
    test "a token that answers every check is accepted, subject and claims intact" do
      assert {:ok, %IdToken{subject: "subject-1", claims: verified}} =
               IdToken.verify_claims(claims(), @config, @discovery, @nonce, @now)

      assert verified["preferred_username"] == "vjt@example.com"
    end

    test "an issuer that is not the configured one is refused" do
      bad = claims(iss: "https://idm.example.net")

      assert {:error, :invalid_token} =
               IdToken.verify_claims(bad, @config, @discovery, @nonce, @now)
    end

    test "an issuer with a trailing slash still matches the configured one" do
      slashed = claims(iss: @issuer <> "/")

      assert {:ok, %IdToken{}} = IdToken.verify_claims(slashed, @config, @discovery, @nonce, @now)
    end

    test "a token minted for another client is refused" do
      bad = claims(aud: "some-other-client")

      assert {:error, :invalid_token} =
               IdToken.verify_claims(bad, @config, @discovery, @nonce, @now)
    end

    test "a multi-audience token is accepted only when azp pins this client" do
      multi = claims(aud: ["some-other-client", @client_id], azp: @client_id)

      assert {:ok, %IdToken{}} = IdToken.verify_claims(multi, @config, @discovery, @nonce, @now)

      unpinned = claims(aud: ["some-other-client", @client_id], azp: "some-other-client")

      assert {:error, :invalid_token} =
               IdToken.verify_claims(unpinned, @config, @discovery, @nonce, @now)
    end

    test "a token at or past exp, leeway included, is an EXPIRY and not a forgery" do
      within_leeway = claims(exp: @now - 59)

      assert {:ok, %IdToken{}} =
               IdToken.verify_claims(within_leeway, @config, @discovery, @nonce, @now)

      expired = claims(exp: @now - 61)

      assert {:error, :expired_token} =
               IdToken.verify_claims(expired, @config, @discovery, @nonce, @now)

      exactly = claims(exp: @now - 60)

      assert {:error, :expired_token} =
               IdToken.verify_claims(exactly, @config, @discovery, @nonce, @now)
    end

    test "a token with no exp is refused — expiry is not optional here" do
      assert {:error, :invalid_token} =
               IdToken.verify_claims(claims(exp: nil), @config, @discovery, @nonce, @now)
    end

    test "a token not yet valid is refused" do
      not_yet = claims(nbf: @now + 61)

      assert {:error, :invalid_token} =
               IdToken.verify_claims(not_yet, @config, @discovery, @nonce, @now)
    end

    test "a nonce other than the one we sent is refused" do
      bad = claims(nonce: "somebody-else's-round-trip")

      assert {:error, :invalid_token} =
               IdToken.verify_claims(bad, @config, @discovery, @nonce, @now)
    end

    test "a token with no nonce at all is refused — the check is not skippable" do
      assert {:error, :invalid_token} =
               IdToken.verify_claims(claims(nonce: nil), @config, @discovery, @nonce, @now)
    end

    test "an empty sub is refused: it is the only claim we store" do
      for empty <- ["", nil] do
        assert {:error, :invalid_token} =
                 IdToken.verify_claims(claims(sub: empty), @config, @discovery, @nonce, @now)
      end
    end
  end

  describe "verify/5 — the signature leg" do
    test "a token signed by a key the provider publishes verifies" do
      compact = compact_jws(%{"alg" => "ES256", "kid" => @kid}, claims())

      assert {:ok, %IdToken{subject: "subject-1"}} =
               IdToken.verify(compact, @config, @discovery, @nonce, @now)
    end

    test "a token signed by a key the provider does not publish refuses" do
      # The forger names the provider's `kid` and signs with its own key:
      # a well-formed token, valid JSON, and a signature that answers to
      # nobody in the JWKS.
      compact = compact_jws(@forged_jwk, %{"alg" => "ES256", "kid" => @kid}, claims())

      assert {:error, :invalid_token} =
               IdToken.verify(compact, @config, @discovery, @nonce, @now)
    end

    test "an algorithm outside the allowlist is refused before a key is selected" do
      # Signed for real with the public key treated as an HMAC secret —
      # the exact move algorithm confusion asks for, and worthless here.
      secret = @jwks["keys"] |> hd() |> Map.fetch!("x")
      compact = compact_hs256(%{"alg" => "HS256", "kid" => @kid}, claims(), secret)

      assert {:error, :invalid_token} =
               IdToken.verify(compact, @config, @discovery, @nonce, @now)
    end

    test "`none` is refused" do
      header = Base.url_encode64(Jason.encode!(%{"alg" => "none", "kid" => @kid}), padding: false)
      payload = Base.url_encode64(Jason.encode!(claims()), padding: false)

      assert {:error, :invalid_token} =
               IdToken.verify(header <> "." <> payload <> ".", @config, @discovery, @nonce, @now)
    end

    test "a kid the provider does not publish is refused" do
      compact = compact_jws(%{"alg" => "ES256", "kid" => "nobody's-key"}, claims())

      assert {:error, :invalid_token} =
               IdToken.verify(compact, @config, @discovery, @nonce, @now)
    end

    test "a gibberish compact serialization is refused, not raised" do
      for garbage <- ["", "not-a-token", "a.b.c"] do
        assert {:error, :invalid_token} =
                 IdToken.verify(garbage, @config, @discovery, @nonce, @now)
      end
    end

    test "an empty JWKS refuses rather than verifies against nothing" do
      :ok = Jwks.put_test_keys(@discovery.jwks_uri, [])
      compact = compact_jws(%{"alg" => "ES256", "kid" => @kid}, claims())

      assert {:error, :invalid_token} =
               IdToken.verify(compact, @config, @discovery, @nonce, @now)
    end
  end

  # `JOSE.JWT.sign/3` takes key, header, claims — in THAT order. Piping
  # the claims in as the first argument puts the header where the key
  # belongs and JOSE answers `{:error, {:missing_required_keys, ["alg"]}}`
  # from inside `:jose_jws.from/1`, which is not a failure worth
  # rediscovering.
  # `JOSE.JWS.compact/1` answers `{modules, compact}`; the token under
  # test is the compact string.
  defp compact_jws(jwk_map, header, claims_map) do
    {_, compact} = JOSE.JWT.sign(JOSE.JWK.from_map(jwk_map), header, claims_map) |> JOSE.JWS.compact()

    compact
  end

  defp compact_jws(header, claims_map), do: compact_jws(@jwk, header, claims_map)

  defp compact_hs256(header, claims_map, secret) do
    signing_input =
      Enum.map_join([header, claims_map], ".", fn part ->
        Base.url_encode64(Jason.encode!(part), padding: false)
      end)

    signature =
      signing_input
      |> hmac_sha256(secret)
      |> Base.url_encode64(padding: false)

    signing_input <> "." <> signature
  end

  defp hmac_sha256(message, secret), do: :crypto.mac(:hmac, :sha256, secret, message)
end
