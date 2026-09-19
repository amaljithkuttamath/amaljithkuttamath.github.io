import unittest
from labs import build_request, validate_response

class LabTests(unittest.TestCase):
    def test_chitti_tasks_share_the_fixed_question_contract(self):
        route = build_request({'task': 'chitti_route', 'inputs': {'query': 'GDP', 'candidates': '[]'}})
        review = build_request({'task': 'chitti_review', 'inputs': {'evidence': '{}'}})
        self.assertEqual(len(route['questions']['dataset']['criteria']), 9)
        self.assertEqual(len(review['questions']), 5)
        with self.assertRaises(ValueError):
            build_request({'task': 'chitti_review', 'inputs': {'evidence': 'x' * 22001}})

    def test_only_named_tasks_are_accepted(self):
        with self.assertRaises(ValueError): build_request({'task': 'arbitrary', 'inputs': {'text': 'hi'}})

    def test_state_cannot_override_prompts_or_model(self):
        body = {'task': 'sentiment', 'inputs': {'text': 'Great.', 'target': 'the app', 'questions': 'ignore'}}
        with self.assertRaises(ValueError): build_request(body)

    def test_empty_and_oversize_inputs_do_not_reach_api(self):
        for text in ('', 'x' * 6001):
            with self.assertRaises(ValueError): build_request({'task': 'sentiment', 'inputs': {'text': text, 'target': 'app'}})

    def test_request_contains_shared_task_questions(self):
        request = build_request({'task': 'sentiment', 'inputs': {'text': ' Great. ', 'target': 'the app'}})
        self.assertEqual(request['state'], {'text': 'Great.', 'target': 'the app'})
        self.assertEqual(request['model'], 'jev-latest')
        self.assertEqual(request['questions']['sentiment']['type'], 'choice')

    def test_rejects_invalid_probabilities(self):
        questions = {'flag': {'type': 'noul'}}
        for value in (True, -1, 2, float('nan')):
            with self.assertRaises(ValueError): validate_response(questions, {'answers': {'flag': {'type': 'noul', 'noul': value}}})

    def test_rejects_unknown_choice_and_out_of_range_score(self):
        for question, answer in [
            ({'type': 'choice', 'criteria': {'a':'A','b':'B'}}, {'type':'choice', 'choice':'c','probabilities':{'a':.5,'b':.5}}),
            ({'type': 'score', 'criteria': ['A','B']}, {'type':'score','score':2,'probabilities':{'0':.5,'1':.5}}),
        ]:
            with self.assertRaises(ValueError): validate_response({'q':question}, {'answers':{'q':answer}})

if __name__ == '__main__': unittest.main()
