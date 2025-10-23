import { useState } from 'react';
import { SignJWT } from 'jose';

const Login = ({ onLogin }) => {
  const [selectedRole, setSelectedRole] = useState('');
  const [username, setUsername] = useState('');
  const [examRoomId, setExamRoomId] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRoleSelect = (role) => {
    console.log('Role selected:', role);
    setSelectedRole(role);
    // Set dummy credentials based on role
    if (role === 'student') {
      setUsername('student_user');
      setExamRoomId('exam_room_001');
    } else if (role === 'invigilator') {
      setUsername('invigilator_user');
      setExamRoomId('exam_room_001');
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!selectedRole || !username || !examRoomId) return;

    setLoading(true);

    try {
      // Generate JWT token with user data using jose
      const secret = new TextEncoder().encode('supersecret');
      const token = await new SignJWT({
        user_id: username,
        role: selectedRole,
        exam_room_id: examRoomId,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('24h')
        .sign(secret);

      // Simulate login delay
      await new Promise(resolve => setTimeout(resolve, 1000));

      const userData = {
        userId: username,
        role: selectedRole,
        examRoomId: examRoomId,
        token: token,
      };
      
      console.log('Login successful, user data:', userData);
      onLogin(userData);
    } catch (error) {
      console.error('Login error:', error);
      alert('Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h1 className="login-title">ProctorAI</h1>
        <p className="login-subtitle">Select your role to continue</p>

        <div className="role-selector">
          <div className="role-options">
            <div
              className={`role-option ${selectedRole === 'student' ? 'selected' : ''}`}
              onClick={() => handleRoleSelect('student')}
            >
              <h3>🎓 Student</h3>
              <p>Take the exam</p>
            </div>
            <div
              className={`role-option ${selectedRole === 'invigilator' ? 'selected' : ''}`}
              onClick={() => handleRoleSelect('invigilator')}
            >
              <h3>👨‍🏫 Invigilator</h3>
              <p>Monitor students</p>
            </div>
          </div>

          {selectedRole && (
            <form onSubmit={handleLogin} className="login-form">
              <div className="form-group">
                <label>Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Exam Room ID</label>
                <input
                  type="text"
                  value={examRoomId}
                  onChange={(e) => setExamRoomId(e.target.value)}
                  required
                />
              </div>
              <button
                type="submit"
                className="login-button"
                disabled={loading}
              >
                {loading ? 'Logging in...' : 'Login'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default Login;
