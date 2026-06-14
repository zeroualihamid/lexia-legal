"""
Knowledge graph construction using NetworkX.

This script builds a directed graph representing payments without invoices for
account 44110000 (NSFactory). Each payment is a node linked from the account node.
The resulting graph is saved to 'data/payments_knowledge_graph.gexf'.
"""

import os
import pandas as pd
import networkx as nx

# Path to the CSV file generated earlier
CSV_PATH = os.path.join(
    os.path.dirname(__file__), "..", "data", "paiements_sans_facture_44110000.csv"
)
# Output graph file path
OUTPUT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "data", "payments_knowledge_graph.gexf"
)


def build_graph(csv_path: str = CSV_PATH) -> nx.DiGraph:
    """Build a directed knowledge graph from the payments CSV.

    Parameters
    ----------
    csv_path: str
        Path to the CSV containing payments (Date, Libellé, Débit).

    Returns
    -------
    nx.DiGraph
        The constructed graph.
    """
    # Load data
    df = pd.read_csv(csv_path, dtype={"Date": str, "Libellé": str, "Débit": float})

    # Initialise directed graph
    G = nx.DiGraph()

    # Add central account node
    account_node = "44110000"
    G.add_node(account_node, type="account", label="Compte 44110000")

    # Add payment nodes and edges
    for idx, row in df.iterrows():
        payment_id = f"payment_{idx}"
        G.add_node(
            payment_id,
            type="payment",
            label=row["Libellé"],
            date=row["Date"],
            amount=row["Débit"],
        )
        # Edge from account to payment
        G.add_edge(account_node, payment_id, relation="has_payment")

    return G


def save_graph(G: nx.DiGraph, output_path: str = OUTPUT_PATH) -> None:
    """Save the graph to a GEXF file for later visualization."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    nx.write_gexf(G, output_path)
    print(f"Graph saved to {output_path}")


if __name__ == "__main__":
    graph = build_graph()
    save_graph(graph)
