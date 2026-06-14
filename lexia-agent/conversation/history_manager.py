# conversation/history_manager.py

"""
Conversation History Manager
Manages storage and retrieval of conversation messages with optional vector search

Supports:
- Multiple storage backends (SQLite, JSON, Vector DB)
- Semantic search for relevant messages
- Session-based conversation tracking
- Message metadata and embeddings
- Efficient retrieval with caching
"""

from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
from pathlib import Path
import json
import uuid
import sqlite3
from dataclasses import dataclass, field, asdict

from monitoring.logger import get_logger

logger = get_logger(__name__)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class Message:
    """Individual conversation message"""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str = ""
    role: str = "user"  # 'user', 'assistant', 'system'
    content: str = ""
    timestamp: datetime = field(default_factory=datetime.now)
    metadata: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[List[float]] = None
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for storage"""
        data = asdict(self)
        data['timestamp'] = self.timestamp.isoformat()
        return data
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'Message':
        """Create Message from dictionary"""
        # Parse timestamp
        timestamp_str = data.get('timestamp')
        if isinstance(timestamp_str, str):
            timestamp = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
        else:
            timestamp = datetime.now()
        
        return cls(
            id=data.get('id', str(uuid.uuid4())),
            session_id=data.get('session_id', ''),
            role=data.get('role', 'user'),
            content=data.get('content', ''),
            timestamp=timestamp,
            metadata=data.get('metadata', {}),
            embedding=data.get('embedding')
        )


# ============================================================================
# MAIN HISTORY MANAGER
# ============================================================================

class ConversationHistoryManager:
    """
    Manage conversation history with multiple storage backends
    
    Features:
    - Store and retrieve messages
    - Session-based organization
    - Semantic search (with embeddings)
    - Message filtering and search
    - Automatic cleanup of old messages
    
    Usage:
        manager = ConversationHistoryManager(config)
        
        # Add message
        manager.add_message(
            session_id="user-123",
            role="user",
            content="Load sales data"
        )
        
        # Get history
        messages = manager.get_history(session_id="user-123", limit=10)
        
        # Search
        relevant = manager.search_relevant(query="sales data", k=5)
    """
    
    def __init__(
        self,
        config,
        storage_backend: str = "sqlite",  # "sqlite", "json", "vector"
        enable_embeddings: bool = False
    ):
        self.config = config
        self.storage_backend = storage_backend
        self.enable_embeddings = enable_embeddings
        
        # Initialize storage
        self.storage = self._initialize_storage(storage_backend)
        
        # Initialize embedder if needed
        self.embedder = None
        if enable_embeddings:
            self.embedder = self._initialize_embedder()
        
        logger.info(
            f"ConversationHistoryManager initialized with {storage_backend} backend"
        )
    
    # ========================================================================
    # PUBLIC INTERFACE
    # ========================================================================
    
    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict] = None
    ) -> str:
        """
        Add a message to conversation history
        
        Args:
            session_id: Session identifier
            role: Message role ('user', 'assistant', 'system')
            content: Message content
            metadata: Optional metadata
            
        Returns:
            str: Message ID
        """
        # Create message
        message = Message(
            session_id=session_id,
            role=role,
            content=content,
            metadata=metadata or {}
        )
        
        # Generate embedding if enabled
        if self.enable_embeddings and self.embedder:
            try:
                message.embedding = self.embedder.embed_text(content)
            except Exception as e:
                logger.warning(f"Failed to generate embedding: {e}")
        
        # Store message
        self.storage.store_message(message)
        
        logger.debug(
            f"Added {role} message to session {session_id}: '{content[:50]}...'"
        )
        
        return message.id
    
    def get_history(
        self,
        session_id: str,
        limit: Optional[int] = None,
        since: Optional[datetime] = None
    ) -> List[Dict]:
        """
        Get conversation history for a session
        
        Args:
            session_id: Session identifier
            limit: Maximum number of messages (most recent)
            since: Only messages after this timestamp
            
        Returns:
            List of message dictionaries
        """
        messages = self.storage.get_messages(
            session_id=session_id,
            limit=limit,
            since=since
        )
        
        logger.debug(f"Retrieved {len(messages)} messages for session {session_id}")
        
        return [msg.to_dict() for msg in messages]
    
    def get_recent_history(
        self,
        session_id: str,
        limit: int = 10
    ) -> List[Dict]:
        """
        Get recent conversation history
        
        Convenience method for get_history with limit.
        """
        return self.get_history(session_id=session_id, limit=limit)
    
    def search_relevant(
        self,
        query: str,
        k: int = 5,
        exclude_session: Optional[str] = None
    ) -> List[Dict]:
        """
        Search for relevant messages using semantic search
        
        Args:
            query: Search query
            k: Number of results
            exclude_session: Exclude messages from this session
            
        Returns:
            List of relevant messages with similarity scores
        """
        if not self.enable_embeddings or not self.embedder:
            logger.warning("Semantic search requires embeddings to be enabled")
            return []
        
        try:
            # Generate query embedding
            query_embedding = self.embedder.embed_text(query)
            
            # Search in storage
            results = self.storage.search_similar(
                embedding=query_embedding,
                k=k,
                exclude_session=exclude_session
            )
            
            logger.debug(f"Found {len(results)} relevant messages for query")
            
            return results
        
        except Exception as e:
            logger.error(f"Failed to search relevant messages: {e}")
            return []
    
    def get_relevant_context(
        self,
        session_id: str,
        query: str,
        k: int = 5
    ) -> List[Dict]:
        """
        Get relevant context for query augmentation
        
        Combines recent history with semantically similar messages.
        
        Args:
            session_id: Current session
            query: Current query
            k: Number of similar messages to retrieve
            
        Returns:
            List of relevant messages
        """
        # Get recent history
        recent = self.get_recent_history(session_id=session_id, limit=5)
        
        # Get similar messages from other sessions
        similar = self.search_relevant(
            query=query,
            k=k,
            exclude_session=session_id
        )
        
        # Combine (recent first)
        context = recent + similar
        
        logger.debug(
            f"Built context: {len(recent)} recent + {len(similar)} similar messages"
        )
        
        return context
    
    def delete_session(self, session_id: str) -> bool:
        """
        Delete all messages for a session
        
        Args:
            session_id: Session to delete
            
        Returns:
            bool: Success status
        """
        try:
            self.storage.delete_session(session_id)
            logger.info(f"Deleted session: {session_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete session {session_id}: {e}")
            return False

    def clear_session(self, session_id: str) -> bool:
        """Alias for delete_session for API compatibility."""
        return self.delete_session(session_id)

    def list_sessions(self) -> List[Dict[str, Any]]:
        """List conversation sessions with their messages."""
        try:
            sessions = self.storage.list_sessions()
            logger.debug(f"Listed {len(sessions)} conversation sessions")
            return sessions
        except Exception as e:
            logger.error(f"Failed to list sessions: {e}")
            return []
    
    def cleanup_old_messages(self, days: int = 30) -> int:
        """
        Delete messages older than specified days
        
        Args:
            days: Delete messages older than this many days
            
        Returns:
            int: Number of messages deleted
        """
        cutoff_date = datetime.now() - timedelta(days=days)
        
        try:
            count = self.storage.delete_before(cutoff_date)
            logger.info(f"Cleaned up {count} messages older than {days} days")
            return count
        except Exception as e:
            logger.error(f"Failed to cleanup old messages: {e}")
            return 0
    
    # ========================================================================
    # INITIALIZATION HELPERS
    # ========================================================================
    
    def _initialize_storage(self, backend: str):
        """Initialize storage backend"""
        
        conv_dir = Path(getattr(self.config, "conversation_dir", "data/conversations"))
        conv_dir.mkdir(parents=True, exist_ok=True)

        if backend == "sqlite":
            db_path = conv_dir / "conversations.db"
            return SQLiteStorage(db_path)
        
        elif backend == "json":
            return JSONStorage(conv_dir)
        
        elif backend == "vector":
            logger.warning("Vector backend not implemented, using SQLite")
            db_path = conv_dir / "conversations.db"
            return SQLiteStorage(db_path)
        
        else:
            raise ValueError(f"Unknown storage backend: {backend}")
    
    def _initialize_embedder(self):
        """Initialize text embedder for semantic search"""
        
        try:
            # Use simple sentence transformer
            from sentence_transformers import SentenceTransformer
            
            model_name = getattr(
                self.config,
                'embedding_model',
                'all-MiniLM-L6-v2'
            )
            
            embedder = TextEmbedder(model_name)
            logger.info(f"Initialized embedder: {model_name}")
            return embedder
        
        except ImportError:
            logger.warning(
                "sentence-transformers not available, semantic search disabled"
            )
            return None
        except Exception as e:
            logger.error(f"Failed to initialize embedder: {e}")
            return None


# ============================================================================
# SQLITE STORAGE BACKEND
# ============================================================================

class SQLiteStorage:
    """SQLite-based storage for conversation messages"""
    
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._ensure_database()
    
    def _ensure_database(self):
        """Create database and tables if they don't exist"""
        
        # Ensure directory exists
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Create tables
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                metadata TEXT,
                embedding BLOB
            )
        """)
        
        # Create indices for faster queries
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_session_timestamp
            ON messages(session_id, timestamp DESC)
        """)
        
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_timestamp
            ON messages(timestamp DESC)
        """)
        
        conn.commit()
        conn.close()
        
        logger.debug(f"SQLite database ready at {self.db_path}")
    
    def store_message(self, message: Message):
        """Store a message in the database"""
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO messages (id, session_id, role, content, timestamp, metadata, embedding)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            message.id,
            message.session_id,
            message.role,
            message.content,
            message.timestamp.isoformat(),
            json.dumps(message.metadata),
            json.dumps(message.embedding) if message.embedding else None
        ))
        
        conn.commit()
        conn.close()
    
    def get_messages(
        self,
        session_id: str,
        limit: Optional[int] = None,
        since: Optional[datetime] = None
    ) -> List[Message]:
        """Retrieve messages for a session"""
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        query = """
            SELECT id, session_id, role, content, timestamp, metadata, embedding
            FROM messages
            WHERE session_id = ?
        """
        params = [session_id]
        
        if since:
            query += " AND timestamp >= ?"
            params.append(since.isoformat())
        
        query += " ORDER BY timestamp DESC"
        
        if limit:
            query += f" LIMIT {limit}"
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        
        messages = []
        for row in rows:
            metadata = json.loads(row[5]) if row[5] else {}
            embedding = json.loads(row[6]) if row[6] else None
            
            message = Message(
                id=row[0],
                session_id=row[1],
                role=row[2],
                content=row[3],
                timestamp=datetime.fromisoformat(row[4]),
                metadata=metadata,
                embedding=embedding
            )
            messages.append(message)
        
        # Return in chronological order (oldest first)
        return list(reversed(messages))
    
    def search_similar(
        self,
        embedding: List[float],
        k: int = 5,
        exclude_session: Optional[str] = None
    ) -> List[Dict]:
        """
        Search for similar messages using embeddings
        
        Note: This is a basic implementation using cosine similarity.
        For production, consider using a proper vector database.
        """
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        query = "SELECT id, session_id, role, content, timestamp, embedding FROM messages WHERE embedding IS NOT NULL"
        params = []
        
        if exclude_session:
            query += " AND session_id != ?"
            params.append(exclude_session)
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        
        # Calculate similarities
        results = []
        for row in rows:
            msg_embedding = json.loads(row[5])
            similarity = self._cosine_similarity(embedding, msg_embedding)
            
            results.append({
                'id': row[0],
                'session_id': row[1],
                'role': row[2],
                'content': row[3],
                'timestamp': row[4],
                'similarity': similarity
            })
        
        # Sort by similarity and return top k
        results.sort(key=lambda x: x['similarity'], reverse=True)
        return results[:k]
    
    def delete_session(self, session_id: str):
        """Delete all messages for a session"""
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        
        conn.commit()
        conn.close()
    
    def delete_before(self, cutoff_date: datetime) -> int:
        """Delete messages before cutoff date"""
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute(
            "DELETE FROM messages WHERE timestamp < ?",
            (cutoff_date.isoformat(),)
        )
        
        deleted_count = cursor.rowcount
        conn.commit()
        conn.close()
        
        return deleted_count

    def list_sessions(self) -> List[Dict[str, Any]]:
        """Return all sessions with their messages, newest first."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        cursor.execute("""
            SELECT session_id, id, role, content, timestamp, metadata, embedding
            FROM messages
            ORDER BY timestamp ASC
        """)
        rows = cursor.fetchall()
        conn.close()

        sessions: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            session_id = row[0]
            metadata = json.loads(row[5]) if row[5] else {}
            embedding = json.loads(row[6]) if row[6] else None
            message = Message(
                id=row[1],
                session_id=session_id,
                role=row[2],
                content=row[3],
                timestamp=datetime.fromisoformat(row[4]),
                metadata=metadata,
                embedding=embedding,
            )

            if session_id not in sessions:
                sessions[session_id] = {
                    "session_id": session_id,
                    "created_at": message.timestamp.isoformat(),
                    "updated_at": message.timestamp.isoformat(),
                    "messages": [],
                }

            sessions[session_id]["messages"].append(message.to_dict())
            sessions[session_id]["updated_at"] = message.timestamp.isoformat()

        ordered = list(sessions.values())
        ordered.sort(key=lambda item: item["updated_at"], reverse=True)
        return ordered
    
    @staticmethod
    def _cosine_similarity(a: List[float], b: List[float]) -> float:
        """Calculate cosine similarity between two vectors"""
        
        import math
        
        dot_product = sum(x * y for x, y in zip(a, b))
        magnitude_a = math.sqrt(sum(x * x for x in a))
        magnitude_b = math.sqrt(sum(y * y for y in b))
        
        if magnitude_a == 0 or magnitude_b == 0:
            return 0.0
        
        return dot_product / (magnitude_a * magnitude_b)


# ============================================================================
# JSON STORAGE BACKEND
# ============================================================================

class JSONStorage:
    """JSON file-based storage for conversation messages"""
    
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        logger.debug(f"JSON storage initialized at {data_dir}")
    
    def _get_session_file(self, session_id: str) -> Path:
        """Get file path for a session"""
        return self.data_dir / f"{session_id}.json"
    
    def store_message(self, message: Message):
        """Store a message in a JSON file"""
        
        file_path = self._get_session_file(message.session_id)
        
        # Load existing messages
        messages = []
        if file_path.exists():
            with open(file_path, 'r') as f:
                messages = json.load(f)
        
        # Add new message
        messages.append(message.to_dict())
        
        # Save
        with open(file_path, 'w') as f:
            json.dump(messages, f, indent=2)
    
    def get_messages(
        self,
        session_id: str,
        limit: Optional[int] = None,
        since: Optional[datetime] = None
    ) -> List[Message]:
        """Retrieve messages from JSON file"""
        
        file_path = self._get_session_file(session_id)
        
        if not file_path.exists():
            return []
        
        with open(file_path, 'r') as f:
            messages_data = json.load(f)
        
        # Convert to Message objects
        messages = [Message.from_dict(data) for data in messages_data]
        
        # Filter by date if needed
        if since:
            messages = [msg for msg in messages if msg.timestamp >= since]
        
        # Apply limit (most recent)
        if limit:
            messages = messages[-limit:]
        
        return messages
    
    def search_similar(
        self,
        embedding: List[float],
        k: int = 5,
        exclude_session: Optional[str] = None
    ) -> List[Dict]:
        """Search similar messages across all sessions"""
        
        results = []
        
        # Iterate through all session files
        for file_path in self.data_dir.glob("*.json"):
            session_id = file_path.stem
            
            if exclude_session and session_id == exclude_session:
                continue
            
            with open(file_path, 'r') as f:
                messages_data = json.load(f)
            
            for msg_data in messages_data:
                if msg_data.get('embedding'):
                    msg_embedding = msg_data['embedding']
                    similarity = SQLiteStorage._cosine_similarity(embedding, msg_embedding)
                    
                    results.append({
                        'id': msg_data['id'],
                        'session_id': session_id,
                        'role': msg_data['role'],
                        'content': msg_data['content'],
                        'timestamp': msg_data['timestamp'],
                        'similarity': similarity
                    })
        
        # Sort and return top k
        results.sort(key=lambda x: x['similarity'], reverse=True)
        return results[:k]
    
    def delete_session(self, session_id: str):
        """Delete session file"""
        file_path = self._get_session_file(session_id)
        if file_path.exists():
            file_path.unlink()
    
    def delete_before(self, cutoff_date: datetime) -> int:
        """Delete old messages from all sessions"""
        
        deleted_count = 0
        
        for file_path in self.data_dir.glob("*.json"):
            with open(file_path, 'r') as f:
                messages = json.load(f)
            
            original_count = len(messages)
            
            # Filter out old messages
            messages = [
                msg for msg in messages
                if datetime.fromisoformat(msg['timestamp'].replace('Z', '+00:00')) >= cutoff_date
            ]
            
            deleted_count += (original_count - len(messages))
            
            # Save filtered messages
            with open(file_path, 'w') as f:
                json.dump(messages, f, indent=2)
        
        return deleted_count

    def list_sessions(self) -> List[Dict[str, Any]]:
        """Return all JSON-backed sessions with their messages, newest first."""
        sessions: List[Dict[str, Any]] = []

        for file_path in self.data_dir.glob("*.json"):
            with open(file_path, 'r') as f:
                messages_data = json.load(f)

            if not messages_data:
                continue

            created_at = messages_data[0].get('timestamp', datetime.now().isoformat())
            updated_at = messages_data[-1].get('timestamp', created_at)
            sessions.append({
                "session_id": file_path.stem,
                "created_at": created_at,
                "updated_at": updated_at,
                "messages": messages_data,
            })

        sessions.sort(key=lambda item: item["updated_at"], reverse=True)
        return sessions


# ============================================================================
# TEXT EMBEDDER
# ============================================================================

class TextEmbedder:
    """Generate embeddings for text using sentence transformers"""
    
    def __init__(self, model_name: str = 'all-MiniLM-L6-v2'):
        from services.embedding_model_provider import get_embedding_model

        self.model = get_embedding_model(model_name)
        logger.info(f"Loaded embedding model: {model_name}")
    
    def embed_text(self, text: str) -> List[float]:
        """Generate embedding for text"""
        
        embedding = self.model.encode(text, convert_to_numpy=True)
        return embedding.tolist()
    
    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings for multiple texts"""
        
        embeddings = self.model.encode(texts, convert_to_numpy=True)
        return embeddings.tolist()


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example usage of ConversationHistoryManager
    """
    
    from config.settings import settings
    
    # Create manager
    manager = ConversationHistoryManager(
        config=settings,
        storage_backend="sqlite",
        enable_embeddings=False  # Set to True for semantic search
    )
    
    session_id = "example-session-123"
    
    # Add messages
    manager.add_message(
        session_id=session_id,
        role="user",
        content="Load sales.parquet file"
    )
    
    manager.add_message(
        session_id=session_id,
        role="assistant",
        content="Successfully loaded sales.parquet with 10,000 rows"
    )
    
    manager.add_message(
        session_id=session_id,
        role="user",
        content="Calculate total revenue"
    )
    
    # Get history
    history = manager.get_history(session_id=session_id)
    
    print(f"Retrieved {len(history)} messages:")
    for msg in history:
        print(f"  [{msg['role']}]: {msg['content']}")
    
    # Get recent history
    recent = manager.get_recent_history(session_id=session_id, limit=2)
    print(f"\nLast 2 messages:")
    for msg in recent:
        print(f"  [{msg['role']}]: {msg['content']}")
