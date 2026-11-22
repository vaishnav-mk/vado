import { useState, type FormEvent } from "react";
import { Button, Dialog, SensitiveInput } from "@cloudflare/kumo";
import { SignInIcon, SignOutIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useSignedIn } from "./Guard";
import { signIn, signOut } from "../server/session";

export function SignIn() {
  const signedIn = useSignedIn(), router = useRouter();
  const [open, setOpen] = useState(false), [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await signIn({ data: { token } });
      setOpen(false); setToken("");
      await router.invalidate();
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  if (signedIn) {
    return <Button variant="ghost" icon={SignOutIcon} onClick={async () => { await signOut(); await router.invalidate(); }}>Sign out</Button>;
  }
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <Dialog.Trigger render={(p) => <Button {...p} variant="secondary" icon={SignInIcon}>Sign in</Button>} />
      <Dialog className="p-6" size="sm">
        <Dialog.Title className="text-lg font-semibold">Sign in</Dialog.Title>
        <Dialog.Description className="mb-4 text-sm text-kumo-subtle">
          Anyone can watch. To create databases, run commands, restart shards or start test traffic, sign in with the bench token. You stay signed in on this browser for 7 days.
        </Dialog.Description>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <SensitiveInput label="Token" value={token} onValueChange={setToken} autoComplete="current-password" error={error ?? undefined} variant={error ? "error" : "default"} />
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(p) => <Button {...p} variant="secondary">Cancel</Button>} />
            <Button type="submit" variant="primary" loading={busy} disabled={!token.trim()}>Sign in</Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
