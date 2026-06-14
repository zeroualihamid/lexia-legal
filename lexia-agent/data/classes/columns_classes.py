from pydantic import BaseModel, field_validator
from typing import List, Dict, Optional, Any
from datetime import date, datetime
from pathlib import Path
import csv
import re
import unicodedata


class ColumnClass(BaseModel):
    """Represents a single column definition with metadata for embeddings."""
    column_name: str
    description: str
    type: str
    is_categorical: bool
    distinct_values: List[Any] = []
    embedded_values: List[List[Any]] = []
    definition_values: List[Any] = []

    @field_validator('type')
    @classmethod
    def validate_type(cls, v: str) -> str:
        valid_types = ['string', 'integer', 'float', 'boolean', 'date', 'datetime']
        if v not in valid_types:
            raise ValueError(f'Invalid type: {v}. Must be one of {valid_types}')
        return v


class ColumnsClasses(BaseModel):
    """Collection of column definitions for a DataFrame."""
    columns: List[ColumnClass]

    def get_column_by_name(self, column_name: str) -> Optional[ColumnClass]:
        """Get a column definition by its name."""
        return next((column for column in self.columns if column.column_name == column_name), None)

    def get_distinct_values(self, column_name: str) -> List[Any]:
        """Get distinct values for a column."""
        col = self.get_column_by_name(column_name)
        return col.distinct_values if col else []

    def get_embedded_values(self, column_name: str) -> List[Any]:
        """Get embedded values for a column."""
        col = self.get_column_by_name(column_name)
        return col.embedded_values if col else []
    
    def get_categorical_columns(self) -> List[ColumnClass]:
        """Get all categorical columns."""
        return [col for col in self.columns if col.is_categorical]
    
    def get_categorical_column_names(self) -> List[str]:
        """Get names of all categorical columns."""
        return [col.column_name for col in self.columns if col.is_categorical]

