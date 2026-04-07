"""CLI wrappers for brand engine core functions.

Thin wrappers around the same code the API uses. For manual/debug use.

Usage:
    brand-engine grade --image path/to/image.jpg --brand jennikayne
    brand-engine ingest --brand cylndr --images data/cylndr/
    brand-engine drift --image path/to/generated.png --brand jennikayne
    brand-engine health
"""

import json
import sys

import typer
from dotenv import load_dotenv

load_dotenv()

app = typer.Typer(
    name="brand-engine",
    help="Brand compliance engine: Gemini Embed 2 + Cohere v4 dual-fusion",
)


@app.command()
def grade(
    image: str = typer.Option(..., "--image", "-i", help="Path to image to grade"),
    brand: str = typer.Option(..., "--brand", "-b", help="Brand slug"),
    text_query: str = typer.Option(None, "--query", "-q", help="Optional text query"),
    tier: str = typer.Option("brand-dna", "--tier", "-t", help="Index tier"),
    output_json: bool = typer.Option(False, "--json", help="Output as JSON"),
    no_pixel: bool = typer.Option(False, "--no-pixel", help="Skip pixel analysis"),
):
    """Grade an image against a brand profile."""
    from brand_engine.core.grader import BrandGrader
    from brand_engine.core.retriever import load_brand_profile

    profile = load_brand_profile(brand)
    grader = BrandGrader()

    result = grader.grade(
        image_path=image,
        profile=profile,
        text_query=text_query,
        include_pixel_analysis=not no_pixel,
        index_tier=tier,
    )

    if output_json:
        typer.echo(result.model_dump_json(indent=2))
    else:
        typer.echo(f"Gate Decision: {result.gate_decision}")
        typer.echo(f"Combined Z-Score: {result.fusion.combined_z:.4f}")
        typer.echo(f"  Gemini Z: {result.fusion.gemini_score.z_score:.4f} (raw: {result.fusion.gemini_score.raw_score:.4f})")
        typer.echo(f"  Cohere Z: {result.fusion.cohere_score.z_score:.4f} (raw: {result.fusion.cohere_score.raw_score:.4f})")
        typer.echo(f"HITL Required: {result.hitl_required}")
        if result.pixel:
            typer.echo(f"Pixel: sat={result.pixel.saturation_mean:.2f}, clutter={result.pixel.clutter_score:.2f}")
            if result.pixel.palette_match is not None:
                typer.echo(f"  Palette Match: {result.pixel.palette_match:.2f}")


@app.command()
def ingest(
    brand: str = typer.Option(..., "--brand", "-b", help="Brand slug"),
    images: str = typer.Option(..., "--images", help="Path to images directory"),
    tier: str = typer.Option("brand-dna", "--tier", "-t", help="Index tier"),
    documents: str = typer.Option(None, "--docs", help="Path to documents directory"),
    output_json: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Ingest brand assets into Pinecone indexes."""
    from brand_engine.core.indexer import BrandIndexer
    from brand_engine.core.retriever import load_brand_profile

    profile = load_brand_profile(brand)
    indexer = BrandIndexer()

    result = indexer.ingest(
        profile=profile,
        images_dir=images,
        index_tier=tier,
        documents_dir=documents,
    )

    if output_json:
        typer.echo(result.model_dump_json(indent=2))
    else:
        typer.echo(f"Indexed {result.vectors_indexed} vectors for {result.brand_slug}")
        typer.echo(f"  Gemini index: {result.gemini_index}")
        typer.echo(f"  Cohere index: {result.cohere_index}")
        if result.errors:
            typer.echo(f"  Errors: {len(result.errors)}")
            for e in result.errors[:5]:
                typer.echo(f"    - {e}")


@app.command()
def drift(
    image: str = typer.Option(..., "--image", "-i", help="Path to image to check"),
    brand: str = typer.Option(..., "--brand", "-b", help="Brand slug"),
    text_query: str = typer.Option(None, "--query", "-q", help="Optional text query"),
    tier: str = typer.Option("core", "--tier", "-t", help="Index tier"),
    output_json: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Check a generated image for brand drift."""
    from brand_engine.core.grader import BrandGrader
    from brand_engine.core.retriever import load_brand_profile

    profile = load_brand_profile(brand)
    grader = BrandGrader()

    grade_result = grader.grade(
        image_path=image,
        profile=profile,
        text_query=text_query,
        include_pixel_analysis=True,
        index_tier=tier,
    )

    # Simplified drift check (baseline comparison would come from Supabase)
    drift_delta = grade_result.fusion.combined_z
    abs_delta = abs(drift_delta)
    severity = "none" if abs_delta < 0.5 else "minor" if abs_delta < 1.0 else "moderate" if abs_delta < 2.0 else "severe"

    if output_json:
        from brand_engine.core.models import DriftReport
        report = DriftReport(
            grade=grade_result,
            baseline_combined_z=0.0,
            drift_delta=drift_delta,
            drift_severity=severity,
            alert_triggered=severity in ("moderate", "severe"),
        )
        typer.echo(report.model_dump_json(indent=2))
    else:
        typer.echo(f"Drift Severity: {severity}")
        typer.echo(f"Drift Delta: {drift_delta:.4f}")
        typer.echo(f"Gate Decision: {grade_result.gate_decision}")
        typer.echo(f"Alert Triggered: {severity in ('moderate', 'severe')}")


@app.command()
def health():
    """Check connectivity to backend services."""
    from brand_engine.core.embeddings import get_embedding_client
    from brand_engine.core.pinecone_client import check_connectivity as check_pinecone

    typer.echo("Checking connectivity...")

    try:
        embed = get_embedding_client()
        connectivity = embed.check_connectivity()
    except Exception as e:
        typer.echo(f"Embedding client init failed: {e}", err=True)
        connectivity = {"gemini": False, "cohere": False}

    pinecone_ok = check_pinecone()

    typer.echo(f"  Gemini Embedding 2: {'OK' if connectivity.get('gemini') else 'FAIL'}")
    typer.echo(f"  Cohere v4: {'OK' if connectivity.get('cohere') else 'FAIL'}")
    typer.echo(f"  Pinecone: {'OK' if pinecone_ok else 'FAIL'}")

    all_ok = all([connectivity.get("gemini"), connectivity.get("cohere"), pinecone_ok])
    typer.echo(f"\nOverall: {'ALL CONNECTED' if all_ok else 'DEGRADED'}")

    if not all_ok:
        raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
