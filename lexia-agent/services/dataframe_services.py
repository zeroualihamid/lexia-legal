import sys
import json
from pathlib import Path
import logging

# Add project root to path (1 level up from this file)
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from typing import List, Dict, Any, Optional, Union
import numpy as np
import pandas as pd
import unicodedata
import re
from difflib import SequenceMatcher
from data.classes.columns_classes import (
    ColumnClass,
    ColumnsClasses,

)

from tools.qvd_reader import QVDReader
from sklearn.metrics.pairwise import cosine_similarity
import ast

logger = logging.getLogger(__name__)

DEFAULT_PARQUET_PATH: Optional[Path] = None
DEFAULT_SCHEMA_PATH: Optional[Path] = None
DEFAULT_COLUMNS_EMBEDDINGS_PATH: Optional[Path] = None

# French-capable multilingual model (covers French well)
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


class DataFrameService:
    """
    Service class for DataFrame operations with semantic embeddings.
    Handles QVD loading, embedding generation, and semantic search.
    """
    
    def __init__(self, model_name: str = MODEL_NAME, original_df: pd.DataFrame = None, enriched_df: pd.DataFrame = None):
        """
        Initialize the DataFrameService with a sentence transformer model.

        Args:
            model_name: Name of the sentence transformer model to use
        """
        self.model_name = model_name
        from services.embedding_model_provider import get_embedding_model
        self.model = get_embedding_model(model_name)
        # Dictionary of DataFrames (for multi-table architecture)
        self.dataframes: Dict[str, pd.DataFrame] = {}
        # Backward compatibility - keep original_df for single DataFrame usage
        self.original_df = original_df
        self.enriched_df = enriched_df
        self.columns_classes = None

    @staticmethod
    def _normalize_text(text: str) -> str:
        """Normalize text for case-insensitive semantic matching."""
        if text is None:
            return ""
        if not isinstance(text, str):
            text = str(text)
        text = unicodedata.normalize("NFKC", text)
        return text.strip().lower()

    @staticmethod
    def _sanitize_column_name(name: str) -> str:
        """
        Sanitize column names by removing special characters and replacing spaces with underscores.
        Makes column names Python-safe and easier to work with in scripts.
        
        Args:
            name: Original column name (e.g., "Date d'entrée")
            
        Returns:
            Sanitized column name (e.g., "Date_d_entree")
        """
        if not name:
            return name
        
        # First, replace apostrophes/quotes with underscores BEFORE removing spaces
        # This ensures "d'entrée" becomes "d_entree" not "dentree"
        sanitized = name.replace("'", "_").replace("'", "_").replace('"', "_")
        
        # Replace spaces with underscores
        sanitized = sanitized.replace(" ", "_")
        
        # Normalize unicode (remove accents)
        sanitized = unicodedata.normalize("NFKD", sanitized)
        sanitized = "".join(ch for ch in sanitized if unicodedata.category(ch) != "Mn")
        
        # Remove any remaining non-alphanumeric characters except underscores
        sanitized = re.sub(r"[^a-zA-Z0-9_]", "", sanitized)
        
        # Collapse multiple consecutive underscores into one
        sanitized = re.sub(r"_+", "_", sanitized)
        
        # Remove leading/trailing underscores
        sanitized = sanitized.strip("_")
        
        # Ensure it doesn't start with a number
        if sanitized and sanitized[0].isdigit():
            sanitized = "_" + sanitized
        
        return sanitized
    
    @staticmethod
    def _normalize_text_lexical(text: str) -> str:
        """
        Normalize text for lexical (string) similarity:
        - lowercase
        - strip accents/diacritics
        - collapse whitespace
        """
        if text is None:
            return ""
        if not isinstance(text, str):
            text = str(text)
        text = unicodedata.normalize("NFKD", text)
        text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
        text = text.lower().strip()
        text = " ".join(text.split())
        return text

    @classmethod
    def _lexical_similarity(cls, query: str, value: str) -> float:
        """
        Lexical similarity between query and a categorical value (0..1).
        Designed to catch French morphology/variants like:
          - démission ↔ demissionnaire / demissionnaire-maladie

        We compare query against:
        - full value string
        - tokens split on non-alphanumerics (e.g., hyphen)
        and take the max.
        """
        q = cls._normalize_text_lexical(query)
        v = cls._normalize_text_lexical(value)
        if not q or not v:
            return 0.0

        # Fast-path: prefix match on a reasonably sized query
        if len(q) >= 4 and (v.startswith(q) or any(tok.startswith(q) for tok in re.split(r"[^a-z0-9]+", v) if tok)):
            return 1.0

        candidates = [v]
        tokens = [t for t in re.split(r"[^a-z0-9]+", v) if t]
        candidates.extend(tokens)

        best = 0.0
        for cand in candidates:
            best = max(best, SequenceMatcher(None, q, cand).ratio())
            if best >= 1.0:
                break
        return float(best)
    
    @staticmethod
    def load_qvd_to_dataframe(qvd_file_path: str, chunk_size: Optional[int] = None) -> pd.DataFrame:
        """
        Load a QVD file to a pandas dataframe.
        Column names are automatically sanitized (spaces -> underscores, special chars removed).
        
        Args:
            qvd_file_path: Path to the QVD file
            chunk_size: If provided, read in chunks of this size (recommended: 100000 for large files)
            
        Returns:
            pandas DataFrame with sanitized column names
        """
        file_path = Path(qvd_file_path)
        reader = QVDReader(str(file_path.parent))
        df = reader.read_qvd(file_path.name, chunk_size=chunk_size)
        
        # Sanitize column names
        column_mapping = {col: DataFrameService._sanitize_column_name(col) for col in df.columns}
        df = df.rename(columns=column_mapping)
        
        return df

    def save_dataframe_to_parquet(
        self,
        df: Optional[pd.DataFrame] = None,
        path: Optional[str] = None,
    ) -> Path:
        """
        Persist the DataFrame to disk as Parquet (Snappy compression).

        Delegates to the centralised ``write_parquet`` helper so all
        parquet creation goes through a single code-path.
        """
        from nodes.dataloader.parquet_writer_node import write_parquet

        if not path:
            raise ValueError("path is required for save_dataframe_to_parquet")
        target = Path(path)
        if df is None:
            df = self.original_df
        if df is None:
            raise ValueError("No DataFrame available to save.")

        return write_parquet(df, target)

    def load_dataframe_from_parquet(self, path: Optional[str] = None) -> pd.DataFrame:
        """
        Load a parquet file from disk into memory and update `original_df`.
        """
        if not path:
            raise ValueError("path is required for load_dataframe_from_parquet")
        target = Path(path)
        if not target.exists():
            raise FileNotFoundError(f"Parquet file not found: {target}")
        df = pd.read_parquet(target)
        self.original_df = df
        logger.info(f"Loaded DataFrame from parquet: {target} ({df.shape[0]:,} rows)")
        return df

    def load_columns_classes_from_parquet(self, path: Optional[str] = None) -> ColumnsClasses:
        """
        Load columns classes from a parquet file into memory and update `columns_classes`.
        """
        columns_classes = self.load_columns_embeddings_cache(path)
        logger.info(
            f"Loaded columns classes from parquet cache: {path}"
        )
        return columns_classes

    def generate_column_definition_md(
        self,
        qvd_path: str,
        schema_path: Optional[str] = None,
        chunk_size: int = 100000,
    ) -> Path:
        """
        Generate column schema markdown and append sanitized metadata.
        """
        qvd_file = Path(qvd_path)
        reader = QVDReader(str(qvd_file.parent))
        if not schema_path:
            raise ValueError("schema_path is required for generate_column_schema")
        schema_target = Path(schema_path)
        schema_target.parent.mkdir(parents=True, exist_ok=True)

        generated = reader.generate_schema_documentation(
            qvd_file.name,
            output_path=str(schema_target),
            chunk_size=chunk_size,
        )

        sanitized_section = self._build_sanitized_column_section()
        with open(generated, "a", encoding="utf-8") as fh:
            fh.write("\n\n---\n\n")
            fh.write("## Sanitized Column Mapping\n")
            fh.write("| Sanitized Name | Original Name | Description |\n")
            fh.write("|---------------|---------------|-------------|\n")
            fh.write(sanitized_section)

        logger.info(f"Column schema documentation written to: {generated}")
        return Path(generated)

    def refresh_columns_metadata(self) -> None:
        """
        Repopulate `columns_classes` with sanitized descriptions and reset embeddings/distinct values.
        """
        columns_classes = self.get_columns_descriptions()
        for column in columns_classes.columns:
            column.distinct_values = column.distinct_values or []
            column.embedded_values = column.embedded_values or []
            column.definition_values = column.definition_values or []
        self.columns_classes = columns_classes

    def _build_sanitized_column_section(self) -> str:
        """
        Build markdown rows describing sanitized -> original column mappings.
        """
        columns_classes = self.get_columns_descriptions()
        rows = []
        for column in columns_classes.columns:
            original = get_original_column_name(column.column_name)
            description = column.description.replace("|", "\\|")
            rows.append(f"| {column.column_name} | {original} | {description} |\n")
        return "".join(rows)

    def _columns_classes_to_dataframe(self, columns_classes: ColumnsClasses) -> pd.DataFrame:
        """Serialize `ColumnsClasses` into a DataFrame suitable for Parquet."""
        rows = []
        for column in columns_classes.columns:
            rows.append(
                {
                    "column_name": column.column_name,
                    "description": column.description,
                    "type": column.type,
                    "is_categorical": column.is_categorical,
                    "distinct_values": json.dumps(column.distinct_values or [], ensure_ascii=False),
                    "embedded_values": json.dumps(column.embedded_values or [], ensure_ascii=False),
                    "definition_values": json.dumps(column.definition_values or [], ensure_ascii=False),
                }
            )
        return pd.DataFrame(rows)

    def save_columns_embeddings_cache(
        self,
        columns_classes: ColumnsClasses,
        path: Optional[str] = None,
    ) -> Path:
        """Persist column metadata + embeddings to a Parquet cache."""
        from nodes.dataloader.parquet_writer_node import write_parquet

        if not path:
            raise ValueError("path is required for save_columns_embeddings_cache")
        target = Path(path)
        df = self._columns_classes_to_dataframe(columns_classes)
        return write_parquet(df, target)

    def load_columns_embeddings_cache(
        self,
        path: Optional[str] = None,
    ) -> ColumnsClasses:
        """Load cached column metadata + embeddings from Parquet."""
        if not path:
            raise ValueError("path is required for load_columns_embeddings_cache")
        target = Path(path)
        if not target.exists():
            raise FileNotFoundError(f"Columns cache not found: {target}")
        df = pd.read_parquet(target)
        columns = []
        
        for record in df.to_dict(orient="records"):
            if not bool(record["is_categorical"]):
                continue
            columns.append(
                ColumnClass(
                    column_name=record["column_name"],
                    description=record["description"],
                    type=record["type"],
                    is_categorical=bool(record["is_categorical"]),
                    distinct_values=json.loads(record.get("distinct_values") or "[]"),
                    embedded_values=json.loads(record.get("embedded_values") or "[]"),
                    definition_values=json.loads(record.get("definition_values") or "[]"),
                )
            )
        columns_classes = ColumnsClasses(columns=columns)
        self.columns_classes = columns_classes
        logger.info(f"Loaded column embeddings cache from {target}")
        return columns_classes

    def prepare_qvd(
        self,
        qvd_path: str,
        chunk_size: int = 100000,
        parquet_path: Optional[str] = None,
        schema_path: Optional[str] = None,
    ) -> pd.DataFrame:
        """
        Pre-process the QVD: load chunked, persist to parquet, generate schema md, refresh metadata.
        """
        df = self.load_qvd_to_dataframe(qvd_path, chunk_size=chunk_size)
        self.original_df = df
        self.save_dataframe_to_parquet(df, path=parquet_path)
        self.generate_column_definition_md(qvd_path, schema_path=schema_path, chunk_size=chunk_size)
        self.refresh_columns_metadata()
        return df
    
    @staticmethod
    def get_columns_descriptions(table_id: Optional[str] = None) -> ColumnsClasses:
        """
        Get column descriptions for specific table or all tables.

        Args:
            table_id: If provided, return columns for that table only.
                     If None, return merged columns from all tables (for backward compat).
                     Supported values: "commande_entete", "commande_lignes", "article_vente"

        Returns:
            ColumnsClasses with column definitions
        """
        from qclick.classes.sql_tables import (
            get_commande_entete_columns_descriptions,
            get_commande_lignes_columns_descriptions
        )

        # Try to import article_vente if it exists
        try:
            from qclick.classes.sql_tables import get_article_vente_columns_descriptions
            has_article_vente = True
        except ImportError:
            has_article_vente = False

        # Return specific table columns if requested
        if table_id == "commande_entete":
            return get_commande_entete_columns_descriptions()
        elif table_id == "commande_lignes":
            return get_commande_lignes_columns_descriptions()
        elif table_id == "article_vente" and has_article_vente:
            return get_article_vente_columns_descriptions()
        elif table_id is not None:
            # Unknown table_id
            logger.warning(f"Unknown table_id: {table_id}, returning all columns")

        # Return all columns (merged, for context)
        all_columns = []

        # Add columns from commande_entete
        entete_columns = get_commande_entete_columns_descriptions()
        all_columns.extend(entete_columns.columns)

        # Add columns from commande_lignes (excluding duplicate CodeBC)
        lignes_columns = get_commande_lignes_columns_descriptions()
        lignes_unique = [
            col for col in lignes_columns.columns
            if col.column_name != "CodeBC"
        ]
        all_columns.extend(lignes_unique)

        # Add article_vente columns if available
        if has_article_vente:
            article_columns = get_article_vente_columns_descriptions()
            all_columns.extend(article_columns.columns)

        # Deduplicate by column_name (in case of overlaps)
        seen = set()
        unique_columns = []
        for col in all_columns:
            if col.column_name not in seen:
                seen.add(col.column_name)
                unique_columns.append(col)

        return ColumnsClasses(columns=unique_columns)

    def get_table_columns_info(self) -> str:
        """
        Generate formatted table info for LLM context.
        Includes columns per table and relationships.

        Returns:
            Formatted string with table structure and relationships
        """
        from qclick.classes.sql_tables import (
            get_commande_entete_columns_descriptions,
            get_commande_lignes_columns_descriptions
        )

        # Try to import article_vente if it exists
        try:
            from qclick.classes.sql_tables import get_article_vente_columns_descriptions
            has_article_vente = True
        except ImportError:
            has_article_vente = False

        info_parts = ["Available Tables:\n"]

        # Define table configurations
        table_configs = [
            {
                "key": "commande_entete",
                "name": "Order Headers",
                "columns_func": get_commande_entete_columns_descriptions
            },
            {
                "key": "commande_lignes",
                "name": "Order Lines",
                "columns_func": get_commande_lignes_columns_descriptions
            }
        ]

        if has_article_vente:
            table_configs.append({
                "key": "article_vente",
                "name": "Sales Articles",
                "columns_func": get_article_vente_columns_descriptions
            })

        # Generate column info for each table
        for i, config in enumerate(table_configs, 1):
            columns = config["columns_func"]()
            info_parts.append(f"\n{i}. dfs['{config['key']}'] ({config['name']}):")
            for col in columns.columns:
                info_parts.append(f"   - {col.column_name} ({col.type}): {col.description}")

        # Document relationships
        info_parts.append("\n\nRelationships:")
        info_parts.append("- commande_entete.CodeBC ↔ commande_lignes.CodeBC (1:N)")
        if has_article_vente:
            info_parts.append("- commande_lignes.CodeArticle ↔ article_vente.CodeArticle (N:1)")

        return "\n".join(info_parts)

    def calculate_embeddings(self, values: List[str], definitions: Optional[List[str]] = None) -> List[List[Any]]:
        """
        Calculate embeddings for a list of values.
        Uses the sentence-transformers model to calculate the embeddings.

        Args:
            values: list of values to embed

        Returns:
            list of embeddings (each embedding is a list of floats)
        """
        value_embeddings = self.model.encode(values).tolist()
        if definitions is None:
            return [[emb] for emb in value_embeddings]

        definition_embeddings = self.model.encode(definitions).tolist()
        paired: List[List[Any]] = []
        for value_emb, definition_emb, definition in zip(value_embeddings, definition_embeddings, definitions):
            if definition:
                paired.append([value_emb, definition_emb])
            else:
                paired.append([value_emb])
        return paired

    def fetch_column_calcutate_embedding(self, use_chunked: bool = False, qvd_path: Optional[str] = None, chunk_size: int = 100000) -> ColumnsClasses:
        """
        Fetch the distinct values of categorical columns and calculate their embeddings.

        Can operate in two modes:
        1. From loaded DataFrame (use_chunked=False): Uses self.original_df directly
        2. Chunked extraction (use_chunked=True): Extracts distinct values using chunked reading
           without loading the full DataFrame into memory

        Args:
            use_chunked: If True, use chunked extraction from QVD file (requires qvd_path)
            qvd_path: Path to QVD file (required if use_chunked=True)
            chunk_size: Chunk size for chunked extraction (default: 100000)

        Returns:
            ColumnsClasses with distinct values and embeddings populated
        """
        columns_classes = self.get_columns_descriptions()
        categorical_columns = [col.column_name for col in columns_classes.columns if col.is_categorical]

        if use_chunked:
            if qvd_path is None:
                raise ValueError("qvd_path is required when use_chunked=True")

            logger.info(f"Extracting distinct values using chunked reading from {qvd_path}")
            file_path = Path(qvd_path)
            reader = QVDReader(str(file_path.parent))

            original_categorical_columns = get_original_column_names(categorical_columns)
            distinct_values_dict = reader.extract_distinct_values_chunked(
                file_path.name,
                original_categorical_columns,
                chunk_size=chunk_size
            )

            for column in columns_classes.columns:
                if column.is_categorical:
                    original_name = get_original_column_name(column.column_name)
                    if original_name in distinct_values_dict:
                        raw_values = distinct_values_dict[original_name]
                        norm_values = [self._normalize_text(v) for v in raw_values]
                        definition_values = [get_column_definition(column.column_name, v) for v in raw_values]
                        column.distinct_values = raw_values
                        column.definition_values = definition_values
                        column.embedded_values = self.calculate_embeddings(norm_values, definition_values)
                        logger.info(
                            f"Column {column.column_name}: {len(raw_values)} distinct values, embeddings calculated"
                        )
        else:
            df = self.original_df
            if df is None:
                raise ValueError("original_df is not set")

            for column in columns_classes.columns:
                if column.is_categorical:
                    raw_values = list(df[column.column_name].unique())  # type: ignore
                    norm_values = [self._normalize_text(v) for v in raw_values]
                    definition_values = [get_column_definition(column.column_name, v) for v in raw_values]
                    column.distinct_values = raw_values
                    column.definition_values = definition_values
                    column.embedded_values = self.calculate_embeddings(norm_values, definition_values)

        self.columns_classes = columns_classes
        return columns_classes

    def search_dataframe(self, df: pd.DataFrame, search_words: List[str], column_names: List[str], top_k: int = 1000, threshold: float = 0.8) -> pd.DataFrame:
        """
        Recherche sémantique multi-termes / multi-colonnes.
        Calcule une similarité par colonne, puis un score global (produit) et renvoie le top_k.
        
        Args:
            df: DataFrame enrichi avec les colonnes d'embeddings
            search_words: liste des termes de recherche
            column_names: liste des colonnes catégorielles ciblées (sans suffixe _embedding)
            top_k: nombre maximum de résultats à retourner (par défaut: 1000)
            threshold: seuil minimum de similarité globale (par défaut: 0.8)
            
        Returns:
            DataFrame avec les résultats triés par similarité décroissante
        """
        if len(search_words) != len(column_names):
            raise ValueError("search_words et column_names doivent avoir la même longueur.")

        work_df = df.copy()

        similarity_cols = []
        for search_word, column_name in zip(search_words, column_names):
            embed_col = f"{column_name}_embedding"
            if embed_col not in work_df.columns:
                raise ValueError(f"Colonne d'embedding manquante: {embed_col}")

            search_word_norm = self._normalize_text(search_word)
            query_emb = self.model.encode([search_word_norm])[0]

            def cosine_similarity(emb):
                if emb is None or (isinstance(emb, float) and pd.isna(emb)):
                    return np.nan
                vec = np.array(emb)
                denom = (np.linalg.norm(query_emb) * np.linalg.norm(vec))
                if denom == 0:
                    return np.nan
                return float(np.dot(query_emb, vec) / denom)

            sim_col = f"__similarity__{column_name}"
            work_df[sim_col] = work_df[embed_col].apply(cosine_similarity)
            similarity_cols.append(sim_col)

        # Produit des similarités, en remplaçant les NaN par 0 pour éviter de propager les NaN
        work_df["__global_similarity__"] = work_df[similarity_cols].fillna(0).prod(axis=1)

        ranked = work_df.sort_values("__global_similarity__", ascending=False).head(top_k)
        
        # Retourne les résultats avec un score global supérieur au seuil
        results = ranked[ranked["__global_similarity__"] >= threshold].reset_index(drop=True)
        
        # Retourne les résultats avec un score global par ordre décroissant
        #results = ranked.sort_values("__global_similarity__", ascending=False).head(top_k)

        # Identify all embedding columns (columns ending with _embedding)
        embedding_cols = [col for col in results.columns if col.endswith('_embedding')]
        
        # Remove similarity columns, global similarity, and all embedding columns
        columns_to_drop = similarity_cols + ["__global_similarity__"] + embedding_cols
        results = results.drop(columns=columns_to_drop)
        
        return results

    def search_columns_embeddings(self, search_criteria: Dict[str, Union[str, List[str]]], threshold: float = 0.6) -> Dict[str, List[Dict[str, Any]]]:
        """
        Recherche sémantique pour trouver les valeurs distinctes dans les colonnes qui correspondent aux termes de recherche.
        Utilise une similarité hybride (cosinus d'embeddings + similarité lexicale) pour identifier les valeurs distinctes.
        La similarité lexicale améliore la détection des variantes morphologiques françaises (ex: "démission" → "DEMISSIONNAIRE").
        
        Args:
            search_criteria: Dictionnaire où les clés sont les noms de colonnes et les valeurs peuvent être:
                - Une liste de termes: ["commission", "frais"]
                - Une chaîne représentant une liste: "['commission', 'frais']"
                - Une chaîne simple (terme unique): "commission"
                Exemple: {
                    "INTITULE": ["commission", "frais"],
                    "RUBRIQUES": "['COMM', 'INT']",
                    "FILIERES": "DBD"
                }
            threshold: Seuil minimum de similarité (hybride: max entre embedding et lexical). 
                Par défaut: 0.6. Les valeurs avec similarité >= threshold sont retournées.
            
        Returns:
            Dict avec une clé par colonne, contenant une liste de dicts avec 'value', 'definition' et 'similarity'
            Format: {
                "column_name": [
                    {"value": "valeur1", "definition": "...", "similarity": 0.95},
                    {"value": "valeur2", "definition": "...", "similarity": 0.87},
                    ...
                ]
            }
            
        Note:
            La similarité finale est le maximum entre:
            - Similarité cosinus des embeddings (sémantique)
            - Similarité lexicale (morphologie, accents, casse)
            Cela permet de capturer des variantes comme "démission" → "DEMISSIONNAIRE" même si les embeddings
            ne sont pas proches.
        """
        df = self.original_df
        if df is None:
            raise ValueError("original_df is not set")

        # if len(search_words) != len(column_names):
        #     raise ValueError("search_words et column_names doivent avoir la même longueur.")
        
        results = {}
        
        # Get the distinct values and embeddings from the   columns_classes
        columns_classes = self.columns_classes
        if columns_classes is None:
            raise ValueError("columns_classes is not set")
        
        
       
        for column_name, search_words in search_criteria.items():
            # Ensure the column key exists even if no terms are provided (e.g., "[]")
            results.setdefault(column_name, [])

            # Handle different input formats:
            # 1. Already a list → use directly
            # 2. String representing a list (e.g., "['a', 'b']") → parse with ast.literal_eval
            # 3. Plain string (e.g., "commission") → wrap in a list
            if isinstance(search_words, list):
                search_words_list = search_words
            elif isinstance(search_words, str):
                search_words = search_words.strip()
                if search_words.startswith("[") and search_words.endswith("]"):
                    try:
                        search_words_list = ast.literal_eval(search_words)
                    except (ValueError, SyntaxError):
                        # Fallback: treat as single search term
                        search_words_list = [search_words]
                else:
                    # Plain string → single search term
                    search_words_list = [search_words] if search_words else []
            else:
                search_words_list = []
            
            if not search_words_list:
                continue

            for search_word in search_words_list:
                # Normalize the search word and get its embedding
                search_word_norm = self._normalize_text(search_word)
                query_emb = self.model.encode([search_word_norm])[0]

                # Get the column class
                column_class = columns_classes.get_column_by_name(column_name)
                if column_class is None:
                    raise ValueError(f"column_class for {column_name} is not set")
                if not column_class.is_categorical:
                    continue
                
                distinct_values = column_class.distinct_values
                embedded_values = column_class.embedded_values
                definition_values = column_class.definition_values

                for value, candidate_embeddings, definition_value in zip(distinct_values, embedded_values, definition_values):
                    if not candidate_embeddings:
                        continue
                    similarities = cosine_similarity([query_emb], candidate_embeddings)[0]
                    emb_sim = float(max(similarities)) if len(similarities) else 0.0
                    # Hybrid similarity: embeddings + lexical fallback for morphology/variants
                    lex_sim = self._lexical_similarity(search_word, value)
                    similarity = float(max(float(emb_sim), float(lex_sim)))
                    if similarity >= threshold:
                        # Add the value and similarity to the results
                        if column_name not in results:
                            results[column_name] = [{
                                "value": value,
                                "similarity": similarity
                            }]
                        else:
                            results[column_name].append({
                                "value": value,
                                "definition": definition_value,
                                "similarity": similarity
                            })
            
        return results

   

def cli_preprocess(args):
    """
    Pre-processing phase:
    1. Load QVD by chunks
    2. Convert QVD to DataFrame with sanitized column names
    3. Save DataFrame to Parquet (snappy compression)
    4. Generate column schema markdown
    5. Refresh columns metadata
    """
    import time
    
    start_time = time.time()
    print(f"[preprocess] Starting pre-processing phase...")
    print(f"[preprocess] QVD path: {args.qvd_path}")
    print(f"[preprocess] Chunk size: {args.chunk_size:,}")
    print(f"[preprocess] Parquet output: {args.parquet_path}")
    print(f"[preprocess] Schema output: {args.schema_path}")
    print(f"[preprocess] Columns cache: {args.columns_cache_path}")
    
    service = DataFrameService()

    # Run the full pre-processing pipeline
    df = service.prepare_qvd(
        qvd_path=args.qvd_path,
        chunk_size=args.chunk_size,
        parquet_path=args.parquet_path,
        schema_path=args.schema_path,
    )
    columns_classes = service.fetch_column_calcutate_embedding(use_chunked=False)
    cache_target = service.save_columns_embeddings_cache(
        columns_classes,
        path=args.columns_cache_path,
    )
    
    duration = time.time() - start_time
    print(f"[preprocess] Pre-processing complete!")
    print(f"[preprocess] DataFrame: {df.shape[0]:,} rows, {df.shape[1]} columns")
    print(f"[preprocess] Total time: {duration:.2f}s")
    print(f"[preprocess] Parquet saved to: {args.parquet_path}")
    print(f"[preprocess] Schema saved to: {args.schema_path}")
    print(f"[preprocess] Columns cache saved to: {cache_target}")


def cli_run(args):
    """
    Running phase:
    1. Check and load DataFrame from Parquet
    2. Calculate embeddings for categorical columns
    """
    import time
    
    start_time = time.time()
    if not args.parquet_path:
        print("[run] ERROR: --parquet-path is required"); return
    if not args.columns_cache_path:
        print("[run] ERROR: --columns-cache-path is required"); return
    parquet_path = Path(args.parquet_path)
    columns_cache_path = Path(args.columns_cache_path)

    print(f"[run] Starting running phase...")
    print(f"[run] Parquet path: {parquet_path}")
    print(f"[run] Columns cache: {columns_cache_path}")
    
    # Check if parquet exists
    if not parquet_path.exists():
        print(f"[run] ERROR: Parquet file not found at {parquet_path}")
        print(f"[run] Please run 'preprocess' first to generate the parquet file.")
        return
    
    service = DataFrameService()

    # Load DataFrame from parquet
    load_start = time.time()
    df = service.load_dataframe_from_parquet(str(parquet_path))
    load_duration = time.time() - load_start
    print(f"[run] DataFrame loaded: {df.shape[0]:,} rows, {df.shape[1]} columns ({load_duration:.2f}s)")
    
    embed_start = time.time()
    if columns_cache_path.exists():
        columns_classes = service.load_columns_embeddings_cache(str(columns_cache_path))
        print(f"[run] Loaded cached column embeddings from {columns_cache_path}")
    else:
        print(f"[run] Calculating embeddings for categorical columns...")
        columns_classes = service.fetch_column_calcutate_embedding(use_chunked=False)
        service.save_columns_embeddings_cache(columns_classes, path=str(columns_cache_path))
    embed_duration = time.time() - embed_start
    
    # Report results
    categorical_count = sum(1 for col in columns_classes.columns if col.is_categorical)
    total_distinct = sum(len(col.distinct_values) for col in columns_classes.columns if col.is_categorical)
    print(f"[run] Embeddings calculated for {categorical_count} categorical columns ({total_distinct:,} distinct values)")
    print(f"[run] Embedding time: {embed_duration:.2f}s")
    
    total_duration = time.time() - start_time
    print(f"[run] Running phase complete! Total time: {total_duration:.2f}s")
    
    # Return service for interactive use
    return service


def cli_column_values(args):
    """
    Helper CLI to inspect distinct values stored for a categorical column.
    """
    if not args.parquet_path:
        print("[column-values] ERROR: --parquet-path is required"); return
    if not args.columns_cache_path:
        print("[column-values] ERROR: --columns-cache-path is required"); return
    parquet_path = Path(args.parquet_path)
    columns_cache_path = Path(args.columns_cache_path)

    print(f"[column-values] Parquet path: {parquet_path}")
    print(f"[column-values] Columns cache: {columns_cache_path}")

    if not parquet_path.exists():
        print(f"[column-values] ERROR: Parquet file not found at {parquet_path}")
        return

    service = DataFrameService()
    service.load_dataframe_from_parquet(str(parquet_path))

    if columns_cache_path.exists():
        columns_classes = service.load_columns_embeddings_cache(str(columns_cache_path))
    else:
        print("[column-values] Column cache missing, calculating embeddings...")
        columns_classes = service.fetch_column_calcutate_embedding(use_chunked=False)
        service.save_columns_embeddings_cache(columns_classes, path=str(columns_cache_path))

    column = service.columns_classes.get_column_by_name(args.column)
    if column is None:
        sanitized = DataFrameService._sanitize_column_name(args.column)
        column = service.columns_classes.get_column_by_name(sanitized)

    if column is None:
        available = ", ".join(col.column_name for col in service.columns_classes.columns if col.is_categorical)
        print(f"[column-values] Column '{args.column}' not found. Available categorical columns: {available}")
        return

    if not column.distinct_values:
        print(f"[column-values] No distinct values cached for {column.column_name}. Run the embedding pipeline first.")
        return

    limit = args.max_values or len(column.distinct_values)
    print(f"[column-values] Showing up to {limit} distinct values for '{column.column_name}':")
    for idx, value in enumerate(column.distinct_values[:limit], start=1):
        print(f"{idx:3}. {value}")


def cli_info(args):
    """
    Display information about the current data files.
    """
    if not args.parquet_path:
        print("[info] ERROR: --parquet-path is required"); return
    parquet_path = Path(args.parquet_path)
    schema_path = Path(args.schema_path) if args.schema_path else None
    
    print(f"[info] Data file status:")
    print(f"  Parquet: {parquet_path}")
    if parquet_path.exists():
        size_mb = parquet_path.stat().st_size / (1024 * 1024)
        print(f"    Status: EXISTS ({size_mb:.2f} MB)")
        # Quick peek at row count
        df = pd.read_parquet(parquet_path)
        print(f"    Rows: {df.shape[0]:,}, Columns: {df.shape[1]}")
    else:
        print(f"    Status: NOT FOUND")
    
    if schema_path:
        print(f"  Schema: {schema_path}")
        if schema_path.exists():
            size_kb = schema_path.stat().st_size / 1024
            print(f"    Status: EXISTS ({size_kb:.2f} KB)")
        else:
            print(f"    Status: NOT FOUND")
    
    columns_cache_path = Path(args.columns_cache_path) if args.columns_cache_path else None
    if columns_cache_path:
        print(f"  Columns cache: {columns_cache_path}")
        if columns_cache_path.exists():
            size_mb = columns_cache_path.stat().st_size / (1024 * 1024)
            print(f"    Status: EXISTS ({size_mb:.2f} MB)")
        else:
            print(f"    Status: NOT FOUND")


if __name__ == "__main__":
    import argparse
    
    # Configure logging for CLI
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s | %(levelname)s | %(name)s | %(message)s'
    )
    
    parser = argparse.ArgumentParser(
        description="DataFrameService CLI - Pre-process QVD files and run embedding calculations",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Pre-processing phase: Convert QVD to Parquet and generate schema
  python dataframe_services.py preprocess --qvd-path data/abb.qvd
  
  # Running phase: Load Parquet and calculate embeddings
  python dataframe_services.py run
  
  # Check data file status
  python dataframe_services.py info
  
  # Pre-process with custom chunk size
  python dataframe_services.py preprocess --qvd-path data/abb.qvd --chunk-size 50000
        """
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Available commands")
    
    # Preprocess command
    preprocess_parser = subparsers.add_parser(
        "preprocess", 
        help="Pre-process QVD: load chunked, save parquet, generate schema"
    )
    preprocess_parser.add_argument(
        "--qvd-path", 
        type=str, 
        required=True,
        help="Path to the QVD file to process"
    )
    preprocess_parser.add_argument(
        "--chunk-size", 
        type=int, 
        default=100000,
        help="Number of rows per chunk (default: 100000)"
    )
    preprocess_parser.add_argument(
        "--parquet-path", 
        type=str, 
        default=None,
        help="Output path for parquet file (required)"
    )
    preprocess_parser.add_argument(
        "--schema-path", 
        type=str, 
        default=None,
        help="Output path for schema markdown (required)"
    )
    preprocess_parser.add_argument(
        "--columns-cache-path",
        type=str,
        default=None,
        help="Path to write column embeddings cache (required)"
    )
    preprocess_parser.set_defaults(func=cli_preprocess)
    
    # Run command
    run_parser = subparsers.add_parser(
        "run", 
        help="Load parquet and calculate embeddings"
    )
    run_parser.add_argument(
        "--parquet-path", 
        type=str, 
        default=None,
        help="Path to parquet file (required)"
    )
    run_parser.add_argument(
        "--columns-cache-path",
        type=str,
        default=None,
        help="Path to column embeddings cache (required)"
    )
    run_parser.set_defaults(func=cli_run)
    
    values_parser = subparsers.add_parser(
        "column-values",
        help="Display distinct values for a specific categorical column"
    )
    values_parser.add_argument(
        "--parquet-path",
        type=str,
        default=None,
        help="Path to parquet file (required)"
    )
    values_parser.add_argument(
        "--columns-cache-path",
        type=str,
        default=None,
        help="Path to column embeddings cache (required)"
    )
    values_parser.add_argument(
        "--column",
        type=str,
        required=True,
        help="Sanitized column name to inspect (e.g., 'Motif_Depart')"
    )
    values_parser.add_argument(
        "--max-values",
        type=int,
        default=500,
        help="Maximum number of values to show (default: 50)"
    )
    values_parser.set_defaults(func=cli_column_values)
    
    # Info command
    info_parser = subparsers.add_parser(
        "info", 
        help="Display data file status"
    )
    info_parser.add_argument(
        "--parquet-path", 
        type=str, 
        default=None,
        help="Path to parquet file (required)"
    )
    info_parser.add_argument(
        "--schema-path", 
        type=str, 
        default=None,
        help="Path to schema markdown"
    )
    info_parser.add_argument(
        "--columns-cache-path",
        type=str,
        default=None,
        help="Path to column embeddings cache"
    )
    info_parser.set_defaults(func=cli_info)
    
    args = parser.parse_args()
    
    if args.command is None:
        parser.print_help()
    else:
        args.func(args)
    