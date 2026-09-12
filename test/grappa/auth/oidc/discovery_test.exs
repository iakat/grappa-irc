defmodule Grappa.Auth.Oidc.DiscoveryTest do
  @moduledoc """
  The discovery document is the single source of the provider's
  endpoints, so the checks that make it trustworthy live here: the
  document must DESCRIBE the issuer the operator configured, and every
  endpoint it names must be HTTPS. Both refusals read as
  `:provider_unavailable` to the caller — a mis-declared provider is a
  broken door, not a user error — and these tests hold that shape.
  """

  use ExUnit.Case, async: false

  alias Grappa.Auth.Oidc.{Config, Discovery}

  @issuer "https://idm.example.com"

  @config %Config{
    issuer: @issuer,
    client_id: "grappa",
    client_secret: "s3cret",
    redirect_uri: "https://grappa.example.com/auth/oidc/callback",
    scopes: "openid"
  }

  @document %{
    "issuer" => @issuer,
    "authorization_endpoint" => "https://idm.example.com/ui/authorize",
    "token_endpoint" => "https://idm.example.com/oidc/token",
    "jwks_uri" => "https://idm.example.com/oidc/jwks"
  }

  describe "build/2" do
    test "projects the four endpoints the flow consumes" do
      assert {:ok, %Discovery{} = document} = Discovery.build(@config, @document)

      assert %{
               issuer: @issuer,
               authorization_endpoint: "https://idm.example.com/ui/authorize",
               token_endpoint: "https://idm.example.com/oidc/token",
               jwks_uri: "https://idm.example.com/oidc/jwks"
             } = document
    end

    test "an issuer that disagrees with the configured one is refused" do
      look_alike = Map.put(@document, "issuer", "https://idm.example.net")

      assert {:error, :provider_unavailable} = Discovery.build(@config, look_alike)
    end

    test "the issuer compare is trailing-slash-insensitive" do
      slashed = Map.put(@document, "issuer", @issuer <> "/")

      # The config's issuer is what `boot/0` stored: already normalized.
      assert {:ok, %Discovery{issuer: @issuer}} = Discovery.build(@config, slashed)
    end

    test "a cleartext endpoint is refused, whichever one carries it" do
      for key <- ["authorization_endpoint", "token_endpoint", "jwks_uri"] do
        cleartext = Map.put(@document, key, "http://idm.example.com/oidc")

        assert {:error, :provider_unavailable} = Discovery.build(@config, cleartext),
               "#{key} answered cleartext and was accepted"
      end
    end

    test "a missing key is refused, not defaulted" do
      for key <- ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] do
        assert {:error, :provider_unavailable} = Discovery.build(@config, Map.delete(@document, key)),
               "the absent #{key} was defaulted"
      end
    end

    test "a non-string value is refused" do
      assert {:error, :provider_unavailable} =
               Discovery.build(@config, Map.put(@document, "token_endpoint", 42))
    end
  end

  describe "fetch/1 + the cache" do
    test "serves the seeded document without a network round trip" do
      {:ok, seeded} = Discovery.build(@config, @document)
      :ok = Discovery.put_test_discovery(@issuer, seeded)

      assert {:ok, ^seeded} = Discovery.fetch(@config)
    end

    test "the cached document is keyed on the normalized issuer" do
      {:ok, seeded} = Discovery.build(@config, @document)
      :ok = Discovery.put_test_discovery(@issuer <> "/", seeded)

      assert {:ok, ^seeded} = Discovery.fetch(@config)
    end
  end
end
