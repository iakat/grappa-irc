defmodule Grappa.Auth.OidcTest do
  @moduledoc """
  The context surface of `Grappa.Auth.Oidc` (#1911): the PKCE transform,
  the display-label preference order, and the `(issuer, subject) → user`
  link table — including the one refusal that matters, a remote identity
  a second account tries to claim.
  """

  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Auth.Oidc
  alias Grappa.Repo

  @issuer "https://idm.example.com"
  @other_issuer "https://idm.example.net"

  describe "pkce_challenge/1" do
    test "is the RFC 7636 S256 transform, unpadded" do
      # Appendix B of the RFC: the one vector every implementation pins.
      verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"

      assert Oidc.pkce_challenge(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    end
  end

  describe "display_label/1" do
    test "prefers preferred_username, then email, then name, then nothing" do
      assert Oidc.display_label(%{
               "preferred_username" => "vjt",
               "email" => "vjt@example.com",
               "name" => "Vittorio"
             }) == "vjt"

      assert Oidc.display_label(%{"email" => "vjt@example.com", "name" => "Vittorio"}) ==
               "vjt@example.com"

      assert Oidc.display_label(%{"name" => "Vittorio"}) == "Vittorio"
      assert Oidc.display_label(%{}) == nil
    end

    test "an empty or non-string value does not shadow the next preference" do
      assert Oidc.display_label(%{"preferred_username" => "", "email" => "vjt@example.com"}) ==
               "vjt@example.com"

      assert Oidc.display_label(%{"preferred_username" => 42, "email" => "vjt@example.com"}) ==
               "vjt@example.com"
    end
  end

  describe "the link table" do
    setup do
      %{user: user_fixture()}
    end

    test "a user links a remote identity and reads it back", %{user: user} do
      assert {:ok, linked} = Oidc.link_identity(user.id, @issuer, "subject-1", "vjt")
      assert linked.user_id == user.id
      assert linked.label == "vjt"

      assert {:ok, ^linked} = Oidc.find_identity(@issuer, "subject-1")
      assert [%Oidc.Identity{}] = Oidc.list_identities(user.id)
    end

    test "a subject at one issuer is not the same subject at another" do
      {:ok, _} = Oidc.link_identity(user_fixture().id, @issuer, "subject-1", "vjt")

      assert {:error, :not_found} = Oidc.find_identity(@other_issuer, "subject-1")
    end

    test "a second account claiming the same remote identity is refused" do
      first = user_fixture()
      second = user_fixture()

      assert {:ok, _} = Oidc.link_identity(first.id, @issuer, "subject-1", "vjt")

      assert {:error, :already_linked} =
               Oidc.link_identity(second.id, @issuer, "subject-1", "vjt")

      # And the refusal changed nothing: the identity still answers for
      # the account that held it.
      assert {:ok, held} = Oidc.find_identity(@issuer, "subject-1")
      assert held.user_id == first.id
    end

    test "the same account may hold identities at two issuers", %{user: user} do
      assert {:ok, _} = Oidc.link_identity(user.id, @issuer, "subject-1", "vjt")
      assert {:ok, _} = Oidc.link_identity(user.id, @other_issuer, "subject-9", "v")

      assert length(Oidc.list_identities(user.id)) == 2
    end

    test "unlink removes this account's link at one issuer and is honest about a second one", %{
      user: user
    } do
      assert {:ok, _} = Oidc.link_identity(user.id, @issuer, "subject-1", "vjt")
      assert {:ok, _} = Oidc.link_identity(user.id, @other_issuer, "subject-9", "v")

      assert :ok = Oidc.unlink_identity(user.id, @issuer)
      assert {:error, :not_found} = Oidc.find_identity(@issuer, "subject-1")
      assert {:ok, _} = Oidc.find_identity(@other_issuer, "subject-9")

      # Unlinking what is not linked reports it rather than nodding along.
      assert {:error, :not_found} = Oidc.unlink_identity(user.id, @issuer)
    end

    test "deleting the user takes the link with it", %{user: user} do
      assert {:ok, _} = Oidc.link_identity(user.id, @issuer, "subject-1", "vjt")

      Repo.delete!(user)

      assert {:error, :not_found} = Oidc.find_identity(@issuer, "subject-1")
    end
  end
end
