defmodule Grappa.Auth.Oidc.TransactionTest do
  @moduledoc """
  The single-use, TTL-bounded round-trip store (#1911) — the same
  retention contract `Grappa.Accounts.WebAuthnChallengeStore` holds, held
  the same way: a transaction is claimable exactly once, an expired one
  refuses AND evicts, and the sweep drops the ones nobody came back for.
  """

  use ExUnit.Case, async: false

  alias Grappa.Auth.Oidc.Transaction

  @verifier_length 86

  test "put/2 returns the challenge material and a distinct id per transaction" do
    %{id: id, transaction: txn} = Transaction.put(:login, nil)

    assert String.length(txn.verifier) == @verifier_length
    assert String.length(txn.nonce) == @verifier_length
    # Two secrets, not one: a verifier that doubled as the nonce would
    # put the PKCE secret into the provider's `id_token`, i.e. into the
    # browser's hands.
    refute txn.verifier == txn.nonce
    assert txn.intent == :login
    assert txn.user_id == nil
    assert is_binary(id)
  end

  test "a :link transaction is born bound to its account" do
    %{transaction: txn} = Transaction.put(:link, "00000000-0000-4000-8000-000000000000")

    assert txn.intent == :link
    assert txn.user_id == "00000000-0000-4000-8000-000000000000"
  end

  test "a transaction is consumed exactly once" do
    %{id: id, transaction: txn} = Transaction.put(:login, nil)

    assert {:ok, ^txn} = Transaction.take(id)
    assert {:error, :invalid_transaction} = Transaction.take(id)
  end

  test "a transaction at or past its TTL refuses, and refusing it evicts it" do
    # The expired transaction is put BEFORE the clock is sampled, the live
    # one AFTER: `expired`'s deadline is then always at or under
    # `now + ttl` and `live`'s always over it, whichever side of a second
    # tick each put landed on.
    %{id: expired} = Transaction.put(:login, nil)
    now = System.monotonic_time(:second)
    %{id: live, transaction: txn} = Transaction.put(:login, nil)

    assert {:ok, ^txn} = Transaction.take(live, now)

    assert {:error, :invalid_transaction} =
             Transaction.take(expired, now + Transaction.ttl_seconds())

    # A refusal must EVICT: an expired round trip that stayed in the map
    # would answer a later real-time take.
    assert {:error, :invalid_transaction} = Transaction.take(expired)
  end

  test "an unknown id refuses" do
    assert {:error, :invalid_transaction} = Transaction.take(Ecto.UUID.generate())
  end

  test "the sweep drops an abandoned transaction and keeps a live one" do
    # An abandoned round trip is never taken, so the read-path TTL check
    # never sees it — driving the callback directly is what proves the
    # sweep, and needs no control over the monotonic clock.
    now = System.monotonic_time(:second)
    %{transaction: txn} = Transaction.put(:login, nil)

    state = %{
      "abandoned" => {txn, now - 1},
      "live" => {txn, now + Transaction.ttl_seconds()}
    }

    assert {:noreply, swept} = Transaction.handle_info(:sweep, state)
    assert Map.keys(swept) == ["live"]
  end
end
