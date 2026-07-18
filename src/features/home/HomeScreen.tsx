export function HomeScreen() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 text-center">
      <div className="flex size-24 items-center justify-center rounded-3xl bg-felt-800 text-6xl shadow-lg">
        ⛳
      </div>
      <div>
        <h1 className="text-4xl font-bold tracking-tight">Golf</h1>
        <p className="mt-2 text-felt-300">Games between friends.</p>
      </div>
      <p className="text-sm text-stone-400">
        Skins · Nassau · Wolf · Vegas
        <br />
        Coming soon.
      </p>
    </main>
  )
}
