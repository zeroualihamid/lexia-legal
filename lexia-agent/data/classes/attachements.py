from typing import List, Optional
from datetime import datetime
from dataclasses import dataclass
import json


def validate_date(date_string: str) -> Optional[str]:
    """Validate dates before sending to API.
    
    Args:
        date_string: ISO format date string to validate
        
    Returns:
        The original date_string if valid, None otherwise
    """
    try:
        if date_string:
            dt = datetime.fromisoformat(date_string.replace('Z', '+00:00'))
            # Check year range
            if dt.year < 1 or dt.year > 9999:
                return None
        return date_string
    except:
        return None


def parse_date(date_string: str) -> datetime:
    """Parse and validate a date string, returning current datetime if invalid.
    
    Args:
        date_string: ISO format date string to parse
        
    Returns:
        Parsed datetime object, or current datetime if invalid
    """
    clean_date = validate_date(date_string)
    if clean_date:
        return datetime.fromisoformat(clean_date.replace('Z', '+00:00'))
    return datetime.now()
