import { NextResponse } from "next/server";

const ALLOWED = new Set(["nom_famille","prenom","nom_utilisateur","ville","code_postal","societe","profession","siren","siret","steam_id","discord_id"]);

export async function POST(req: Request) {
  const apiKey = process.env.BRIXHUB_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "BRIXHUB_API_KEY is not configured." }, { status: 500 });
  try {
    const incoming = await req.json();
    const body = Object.fromEntries(Object.entries(incoming).filter(([k,v]) => ALLOWED.has(k) && typeof v === "string" && v.trim()).map(([k,v]) => [k, String(v).trim()]));
    if (!Object.keys(body).length) return NextResponse.json({ error: "No permitted search criteria supplied." }, { status: 400 });
    const response = await fetch("https://brixhub.net/api/v1/search", { method:"POST", headers:{"X-API-Key":apiKey,"Content-Type":"application/json","User-Agent":"Noxo-BrixHub-Research/1.0"}, body:JSON.stringify({...body,page:1,per_page:25}), cache:"no-store" });
    const data = await response.json();
    if (!response.ok || data?.status >= 400) return NextResponse.json({ error:data?.message || "BrixHub API error" }, { status: response.status || 502 });
    return NextResponse.json({ results:data?.data?.results || [], meta:data?.meta || null });
  } catch { return NextResponse.json({ error:"Unable to reach BrixHub." }, { status:502 }); }
}