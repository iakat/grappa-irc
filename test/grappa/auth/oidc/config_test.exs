defmodule Grappa.Auth.Oidc.ConfigTest do
  @moduledoc """
  The boot seam and the shape rules of the provider config (#1911).

  `boot/0` is the only door from `Application.get_env(:grappa, :oidc)` to
  the runtime, so the tests here drive it the way `lib/grappa/application.ex`
  does and assert on the struct that comes out — including the two refusals
  (a provider configured without its client secret, and one without a
  redirect URI) that must stay LOUD rather than boot a door that cannot
  complete a round trip.
  """

  use ExUnit.Case, async: false

  alias Grappa.Auth.Oidc.Config

  @pt_key {Grappa.Auth.Oidc.Config, :config}
  @env_key :oidc

  # Sibling tests read the same `:persistent_term` key (and every
  # controller test seeds it), so both halves are restored: the
  # `:grappa, :oidc` env AND the booted value.
  setup do
    original_env = Application.get_env(:grappa, @env_key)
    original_pt = :persistent_term.get(@pt_key, :__unset__)

    on_exit(fn ->
      if is_nil(original_env) do
        Application.delete_env(:grappa, @env_key)
      else
        Application.put_env(:grappa, @env_key, original_env)
      end

      case original_pt do
        :__unset__ -> :persistent_term.erase(@pt_key)
        cfg -> :persistent_term.put(@pt_key, cfg)
      end
    end)

    :ok
  end

  @complete [
    issuer: "https://idm.example.com",
    client_id: "grappa",
    client_secret: "s3cret",
    redirect_uri: "https://grappa.example.com/auth/oidc/callback"
  ]

  describe "boot/0 + config/0" do
    test "no :oidc env boots to nil — the off state" do
      Application.delete_env(:grappa, @env_key)

      assert :ok = Config.boot()
      assert Config.config() == nil
      refute Config.enabled?()
    end

    test "a complete env boots to a struct and arms the door" do
      Application.put_env(:grappa, @env_key, @complete)

      assert :ok = Config.boot()

      assert %Config{
               issuer: "https://idm.example.com",
               client_id: "grappa",
               client_secret: "s3cret",
               redirect_uri: "https://grappa.example.com/auth/oidc/callback",
               scopes: "openid profile email"
             } = Config.config()

      assert Config.enabled?()
    end

    test "a trailing slash on the issuer is trimmed, not stored" do
      Application.put_env(:grappa, @env_key, Keyword.put(@complete, :issuer, "https://idm.example.com/"))

      assert :ok = Config.boot()
      assert %Config{issuer: "https://idm.example.com"} = Config.config()
    end
  end

  describe "the required keys" do
    test "a missing client_secret refuses to boot" do
      Application.put_env(:grappa, @env_key, Keyword.delete(@complete, :client_secret))

      assert_raise ArgumentError, ~r/oidc_client_secret is required/, fn -> Config.boot() end
    end

    test "a missing redirect_uri refuses to boot" do
      Application.put_env(:grappa, @env_key, Keyword.delete(@complete, :redirect_uri))

      assert_raise ArgumentError, ~r/oidc_redirect_uri is required/, fn -> Config.boot() end
    end

    test "an empty string is as good as an absent key" do
      Application.put_env(:grappa, @env_key, Keyword.put(@complete, :client_id, ""))

      assert_raise ArgumentError, ~r/oidc_client_id is required/, fn -> Config.boot() end
    end
  end

  describe "scopes" do
    test "default to openid profile email" do
      Application.put_env(:grappa, @env_key, @complete)

      assert :ok = Config.boot()
      assert Config.config().scopes == Config.default_scopes()
    end

    test "openid is forced on and first, whatever the operator asked for" do
      Application.put_env(:grappa, @env_key, Keyword.put(@complete, :scopes, "email profile"))

      assert :ok = Config.boot()
      assert Config.config().scopes == "openid email profile"
    end

    test "a duplicate openid is collapsed, not stored twice" do
      Application.put_env(:grappa, @env_key, Keyword.put(@complete, :scopes, "openid openid email"))

      assert :ok = Config.boot()
      assert Config.config().scopes == "openid email"
    end

    test "an all-whitespace scopes value falls back to the default" do
      Application.put_env(:grappa, @env_key, Keyword.put(@complete, :scopes, "   "))

      assert :ok = Config.boot()
      assert Config.config().scopes == Config.default_scopes()
    end
  end

  describe "normalize_issuer/1" do
    test "compares providers' trailing-slash disagreement away" do
      assert Config.normalize_issuer("https://idm.example.com/oidc/v1") ==
               Config.normalize_issuer("https://idm.example.com/oidc/v1/")

      assert Config.normalize_issuer("https://idm.example.com") == "https://idm.example.com"
    end
  end

  test "put_test_config/1 substitutes the config in the test env" do
    override = %Config{
      issuer: "https://idm.example.com",
      client_id: "grappa",
      client_secret: "s3cret",
      redirect_uri: "https://grappa.example.com/auth/oidc/callback",
      scopes: "openid"
    }

    Config.put_test_config(override)
    assert Config.config() == override
    assert Config.enabled?()
  end
end
