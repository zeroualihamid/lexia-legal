# nodes/execution/code_writer_node.py

"""
Code Writer Node
Writes validated code to the filesystem with proper organization and metadata

This node:
- Writes code to organized directory structure
- Generates unique filenames
- Adds metadata and documentation
- Formats code (Black, etc.)
- Creates version history
- Provides file paths for execution
"""

from typing import Dict, Any, Optional
from pathlib import Path
from datetime import datetime
import hashlib
import json

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


class CodeWriterNode(BaseNode):
    """
    Code Writer Node - Write code to filesystem
    
    Responsibilities:
    1. Organize output directory structure
    2. Generate unique, descriptive filenames
    3. Write code with proper formatting
    4. Add metadata file alongside code
    5. Create execution-ready files
    6. Track file versions
    
    Output structure:
        /outputs/
            session-123/
                step_1_load_data.py
                step_1_metadata.json
                step_2_calculate.py
                step_2_metadata.json
    """
    
    def __init__(
        self,
        name: Optional[str] = None,
        format_code: bool = True
    ):
        super().__init__(name or "CodeWriter")
        self.format_code = format_code
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare for writing code"""
        self.log_entry(shared)
        
        # Get approved code (from consensus or validation)
        code = shared.get('approved_code')
        
        if not code:
            # Fallback to last generated code
            code = shared.get('last_generated_code')
        
        if not code:
            raise ValueError("No code to write")
        
        # Get session information
        session_id = shared.get('session_id', 'default')
        
        # Get current step
        plan_steps = shared.get('plan_steps', [])
        current_index = shared.get('current_step_index', 0)
        current_step = plan_steps[current_index] if current_index < len(plan_steps) else {}
        
        # Get configuration — domain workflows override the output directory
        config = self.get_config(shared)
        domain_out = shared.get('domain_config', {}).get('output_dir')
        base_output = Path(domain_out) if domain_out else Path(getattr(config, "output_dir", "data/output"))
        output_dir = base_output / session_id
        
        # Get metadata
        metadata = {
            'step_id': current_step.get('id', f'step-{current_index}'),
            'step_description': current_step.get('description', ''),
            'step_index': current_index,
            'session_id': session_id,
            'reused': bool(shared.get('best_match')),
            'generated_at': datetime.now().isoformat(),
            'code_hash': hashlib.sha256(code.encode()).hexdigest()
        }
        
        # Add proposal metadata if available
        if 'proposal' in shared:
            proposal = shared['proposal']
            metadata['proposal'] = {
                'type': proposal.get('proposal_type'),
                'confidence': proposal.get('confidence')
            }
        
        self.logger.info(f"Preparing to write code for {metadata['step_id']}")
        
        return {
            'code': code,
            'metadata': metadata,
            'output_dir': output_dir,
            'step': current_step
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Write code to filesystem
        
        Steps:
        1. Create output directory
        2. Generate filename
        3. Format code (if enabled)
        4. Write code file
        5. Write metadata file
        """
        
        code = prep_result['code']
        metadata = prep_result['metadata']
        output_dir = prep_result['output_dir']
        step = prep_result['step']
        
        # Create output directory
        output_dir.mkdir(parents=True, exist_ok=True)
        self.logger.debug(f"Output directory: {output_dir}")
        
        # Generate filename
        filename = self._generate_filename(metadata, step)
        code_path = output_dir / filename
        
        # Format code if enabled
        if self.format_code:
            try:
                code = self._format_code(code)
                self.logger.debug("Code formatted successfully")
            except Exception as e:
                self.logger.warning(f"Code formatting failed: {e}")
        
        # Write code file
        self.logger.info(f"Writing code to {code_path}")
        
        try:
            with open(code_path, 'w', encoding='utf-8') as f:
                f.write(code)
            
            self.logger.info(f"✓ Code written: {code_path}")
        
        except Exception as e:
            self.logger.error(f"Failed to write code: {e}")
            raise
        
        # Write metadata file
        metadata_path = code_path.with_suffix('.metadata.json')
        
        try:
            with open(metadata_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2)
            
            self.logger.debug(f"Metadata written: {metadata_path}")
        
        except Exception as e:
            self.logger.warning(f"Failed to write metadata: {e}")
        
        # Get file stats
        file_size = code_path.stat().st_size
        
        return {
            'code_path': str(code_path),
            'metadata_path': str(metadata_path),
            'filename': filename,
            'file_size': file_size,
            'lines_of_code': len(code.split('\n')),
            'success': True
        }
    
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: Dict[str, Any]
    ) -> str:
        """Store file paths and route to execution"""
        
        # Store file information
        shared['code_file'] = exec_result
        shared['code_path'] = exec_result['code_path']
        
        # Add to step results
        if 'step_results' not in shared:
            shared['step_results'] = []
        
        shared['step_results'].append({
            'step_id': prep_result['metadata']['step_id'],
            'description': prep_result['metadata'].get('step_description', ''),
            'code_path': exec_result['code_path'],
            'file_size': exec_result['file_size'],
            'written_at': datetime.now().isoformat()
        })
        
        self.logger.info(
            f"Code file ready: {exec_result['filename']} "
            f"({exec_result['file_size']} bytes, "
            f"{exec_result['lines_of_code']} lines)"
        )
        
        self.log_exit('default')
        return 'default'
    
    # ========================================================================
    # HELPER METHODS
    # ========================================================================
    
    def _generate_filename(self, metadata: Dict, step: Dict) -> str:
        """
        Generate descriptive filename
        
        Format: step_{index}_{description_slug}.py
        Example: step_1_load_sales_data.py
        """
        
        step_index = metadata['step_index']
        
        # Create slug from description
        description = step.get('description', 'code')
        slug = self._slugify(description)
        
        # Limit slug length
        if len(slug) > 40:
            slug = slug[:40]
        
        filename = f"step_{step_index}_{slug}.py"
        
        return filename
    
    def _slugify(self, text: str) -> str:
        """Convert text to filename-safe slug"""
        
        # Convert to lowercase
        slug = text.lower()
        
        # Remove special characters
        slug = ''.join(c if c.isalnum() or c in ' -_' else '' for c in slug)
        
        # Replace spaces with underscores
        slug = slug.replace(' ', '_').replace('-', '_')
        
        # Remove duplicate underscores
        while '__' in slug:
            slug = slug.replace('__', '_')
        
        # Remove leading/trailing underscores
        slug = slug.strip('_')
        
        return slug
    
    def _format_code(self, code: str) -> str:
        """Format code using Black"""
        
        try:
            import black
            
            # Format using Black
            formatted = black.format_str(
                code,
                mode=black.Mode(line_length=100)
            )
            
            return formatted
        
        except ImportError:
            self.logger.debug("Black not available, skipping formatting")
            return code
        
        except Exception as e:
            self.logger.warning(f"Black formatting failed: {e}")
            return code


# ============================================================================
# VERSION MANAGEMENT
# ============================================================================

class VersionedCodeWriter(CodeWriterNode):
    """
    Code writer with version management
    
    Keeps history of all versions written
    """
    
    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        """Write code with versioning"""
        
        # Call parent to write main file
        result = super().exec(prep_result)
        
        # Also write to versions directory
        output_dir = prep_result['output_dir']
        versions_dir = output_dir / 'versions'
        versions_dir.mkdir(exist_ok=True)
        
        # Create versioned filename
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        step_id = prep_result['metadata']['step_id']
        version_filename = f"{step_id}_{timestamp}.py"
        version_path = versions_dir / version_filename
        
        # Write version
        with open(version_path, 'w', encoding='utf-8') as f:
            f.write(prep_result['code'])
        
        result['version_path'] = str(version_path)
        
        self.logger.debug(f"Version saved: {version_path}")
        
        return result


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def write_code_to_file(
    code: str,
    filepath: Path,
    metadata: Optional[Dict] = None,
    format_code: bool = True
) -> bool:
    """
    Utility function to write code to file
    
    Args:
        code: Python code string
        filepath: Destination path
        metadata: Optional metadata to write alongside
        format_code: Whether to format with Black
        
    Returns:
        bool: Success status
    """
    
    # Ensure directory exists
    filepath.parent.mkdir(parents=True, exist_ok=True)
    
    # Format if requested
    if format_code:
        try:
            import black
            code = black.format_str(code, mode=black.Mode(line_length=100))
        except:
            pass
    
    # Write code
    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(code)
        
        # Write metadata if provided
        if metadata:
            metadata_path = filepath.with_suffix('.metadata.json')
            with open(metadata_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2)
        
        return True
    
    except Exception as e:
        logger.error(f"Failed to write code: {e}")
        return False


def read_code_from_file(filepath: Path) -> Optional[str]:
    """
    Read code from file
    
    Returns:
        Code string or None if failed
    """
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        logger.error(f"Failed to read code: {e}")
        return None
