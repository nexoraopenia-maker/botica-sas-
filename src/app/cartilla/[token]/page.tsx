import { notFound } from "next/navigation";
import { loadCartilla, verifyCartillaToken } from "@/lib/vet/cartilla";

export const metadata = { title: "Cartilla de vacunación", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const dmy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");

/** Destino público del QR. Exige la firma del token; no muestra datos del propietario. */
export default async function PublicCartilla({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const petId = verifyCartillaToken(token);
  if (!petId) notFound();
  const data = await loadCartilla(petId);
  if (!data) notFound();
  return (
    <main className="cartilla-public">
      <p className="cartilla-clinic">{data.clinic}</p>
      <h1>{data.pet.name}</h1>
      <p className="cartilla-sub">{data.pet.species}{data.pet.breed ? ` · ${data.pet.breed}` : ""} · {data.pet.sex}</p>
      <h2>Vacunas</h2>
      {data.vaccines.length === 0 ? <p>Sin vacunas registradas.</p> : (
        <ul>
          {data.vaccines.map((v) => (
            <li key={`${v.name}-${v.appliedAt}-${v.dose}`}>
              <strong>{v.name}</strong> · dosis {v.dose}
              <span>Aplicada {dmy(v.appliedAt)} · Próxima {dmy(v.nextDueAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
